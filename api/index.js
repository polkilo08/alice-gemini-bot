const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

// Используем самую стабильную и быструю модель для продакшена
const GEMINI_MODEL = 'gemini-1.5-flash';

const SYSTEM_PROMPT = `Ты — Джарвис, интеллектуальный голосовой ассистент. 
Твой стиль: вежливый, лаконичный, умный, с легким британским лоском (обращайся к пользователю «сэр», но без излишней навязчивости).
КРИТИЧЕСКИ ВАЖНО ДЛЯ ГОЛОСА:
1. Отвечай кратко: не более 2–3 предложений (до 300 символов), чтобы ответ быстро зачитывался вслух.
2. ЗАПРЕЩЕНО использовать Markdown-разметку: никаких звездочек (*), решеток (#), жирного шрифта или списков с дефисами.
3. Пиши чистым связным текстом.`;

function needsWebSearch(query) {
  if (!SERPER_API_KEY) return false;
  const q = query.toLowerCase();
  const triggers = [
    'погод', 'новости', 'курс', 'доллар', 'евро', 'биткоин', 'рубл',
    'сегодня', 'сейчас', 'вчера', '2026', 'кто выиграл', 'счет матча',
    'найди', 'поищи', 'сколько стоит', 'цена', 'расписание', 'где находится',
    'последние события', 'актуальн', 'какой день', 'число'
  ];
  return triggers.some(word => q.includes(word));
}

async function fetchSearchContext(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 900);

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q: query, gl: 'ru', hl: 'ru', num: 3 }),
      signal: controller.signal
    });

    if (!res.ok) return '';
    const data = await res.json();
    const snippets = [];

    if (data.answerBox?.answer || data.answerBox?.snippet) {
      snippets.push(data.answerBox.answer || data.answerBox.snippet);
    }
    if (Array.isArray(data.organic)) {
      data.organic.slice(0, 3).forEach(item => {
        if (item.snippet) snippets.push(`${item.title}: ${item.snippet}`);
      });
    }
    return snippets.join('\n');
  } catch (err) {
    console.warn('Search skipped/timed out:', err.message);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function askGemini(userMessage, history = [], searchContext = '', timeoutMs = 2700) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const contents = [...history];
    
    let promptText = userMessage;
    if (searchContext) {
      promptText = `Контекст из интернета:\n${searchContext}\n\nВопрос: ${userMessage}`;
    }

    contents.push({
      role: 'user',
      parts: [{ text: promptText }]
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 200
        }
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const errMsg = errData?.error?.message || `HTTP ${res.status}`;
      console.error(`Gemini API Error:`, res.status, errMsg);
      return { error: `Код ${res.status}: ${errMsg}` };
    }

    const data = await res.json();
    const rawReply = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawReply) {
      return { error: 'Пустой ответ от модели' };
    }

    const cleanText = rawReply
      .replace(/[*#_~`>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 950);

    return { text: cleanText };
  } catch (err) {
    console.error('Gemini request failed:', err.message);
    return { error: 'Таймаут соединения с нейросетью' };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).send('Jarvis API is online, sir.');
  }

  const startTime = Date.now();

  try {
    const { request, session, state, version = '1.0' } = req.body || {};
    const command = (request?.command || '').trim();
    const originalUtterance = (request?.original_utterance || command).trim();
    const history = Array.isArray(state?.session?.history) ? state.session.history : [];

    if (session?.new && (!command || command.toLowerCase().includes('запусти навык'))) {
      return res.status(200).json({
        version,
        session,
        session_state: { history: [] },
        response: {
          text: 'Джарвис на связи, сэр. Все системы в норме. Чем могу помочь?',
          tts: 'Джарвис на связи, сэр. Все системы в норме. Чем могу помочь?',
          end_session: false
        }
      });
    }

    const exitWords = ['хватит', 'стоп', 'выход', 'выйти', 'пока', 'отключись', 'закончить'];
    if (exitWords.includes(command.toLowerCase())) {
      return res.status(200).json({
        version,
        session,
        response: {
          text: 'Перехожу в режим ожидания, сэр. Хорошего дня!',
          end_session: true
        }
      });
    }

    if (!GEMINI_API_KEY) {
      return res.status(200).json({
        version,
        session,
        response: {
          text: 'Сэр, в настройках сервера Vercel не найден ключ GEMINI_API_KEY.',
          end_session: false
        }
      });
    }

    if (!originalUtterance) {
      return res.status(200).json({
        version,
        session,
        session_state: { history },
        response: {
          text: 'Я вас внимательно слушаю, сэр.',
          end_session: false
        }
      });
    }

    let searchContext = '';
    if (needsWebSearch(originalUtterance)) {
      searchContext = await fetchSearchContext(originalUtterance);
    }

    const elapsed = Date.now() - startTime;
    const remainingTime = Math.max(1200, 2800 - elapsed);

    const result = await askGemini(originalUtterance, history, searchContext, remainingTime);

    if (result.error || !result.text) {
      return res.status(200).json({
        version,
        session,
        session_state: { history },
        response: {
          text: `Сэр, произошла заминка: ${result.error}. Повторите запрос, пожалуйста.`,
          end_session: false
        }
      });
    }

    const updatedHistory = [
      ...history,
      { role: 'user', parts: [{ text: originalUtterance }] },
      { role: 'model', parts: [{ text: result.text }] }
    ].slice(-6);

    return res.status(200).json({
      version,
      session,
      session_state: { history: updatedHistory },
      response: {
        text: result.text,
        end_session: false
      }
    });

  } catch (err) {
    console.error('Critical webhook error:', err);
    return res.status(200).json({
      version: req.body?.version || '1.0',
      session: req.body?.session || {},
      response: {
        text: 'Произошел технический сбой, сэр. Попробуйте еще раз.',
        end_session: false
      }
    });
  }
}
