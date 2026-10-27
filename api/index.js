const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

// Используем самую быструю актуальную модель Flash
const GEMINI_MODEL = 'gemini-2.5-flash';

const SYSTEM_PROMPT = `Ты — Джарвис, интеллектуальный голосовой ассистент. 
Твой стиль: вежливый, лаконичный, умный, с легким британским лоском (обращайся к пользователю «сэр», но без излишней навязчивости).
КРИТИЧЕСКИ ВАЖНО ДЛЯ ГОЛОСА:
1. Отвечай кратко: не более 2–3 предложений (до 350 символов), чтобы ответ быстро зачитывался вслух.
2. ЗАПРЕЩЕНО использовать Markdown-разметку: никаких звездочек (*), решеток (#), жирного шрифта или списков с дефисами — Алиса не умеет их красиво читать.
3. Пиши чистым связным текстом, числа и единицы измерения пиши так, чтобы их было легко произнести.`;

// Определяем, нужен ли интернет-поиск для конкретного запроса
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

// Запрос в Google через Serper API с жестким таймаутом 1100 мс
async function fetchSearchContext(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1100);

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

// Запрос к Gemini REST API с поддержкой истории сессии
async function askGemini(userMessage, history = [], searchContext = '', timeoutMs = 2400) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const contents = [...history];
    
    let promptText = userMessage;
    if (searchContext) {
      promptText = `Контекст из интернета (актуальные данные на сегодня):\n${searchContext}\n\nВопрос пользователя: ${userMessage}`;
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
          maxOutputTokens: 220
        }
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Gemini API Error:', res.status, errText);
      return null;
    }

    const data = await res.json();
    const rawReply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawReply) return null;

    // Очищаем текст от символов разметки и лишних переносов
    return rawReply
      .replace(/[*#_~`>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 950);
  } catch (err) {
    console.error('Gemini request aborted/failed:', err.message);
    return null;
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

    // 1. Приветствие при старте навыка
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

    // 2. Команды завершения работы навыка
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

    // 3. Проверка наличия ключа
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

    // 4. Если пустой ввод (например, шум в микрофоне)
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

    // 5. Поиск информации в интернете при необходимости
    let searchContext = '';
    if (needsWebSearch(originalUtterance)) {
      searchContext = await fetchSearchContext(originalUtterance);
    }

    // Вычисляем оставшийся запас времени, чтобы строго уложиться в 2850 мс
    const elapsed = Date.now() - startTime;
    const remainingTime = Math.max(900, 2850 - elapsed);

    // 6. Запрос к Gemini
    const answer = await askGemini(originalUtterance, history, searchContext, remainingTime);

    if (!answer) {
      return res.status(200).json({
        version,
        session,
        session_state: { history },
        response: {
          text: 'Прошу прощения, сэр, каналы связи с нейросетью перегружены. Повторите вопрос, пожалуйста.',
          end_session: false
        }
      });
    }

    // 7. Сохраняем последние 6 реплик (3 вопроса + 3 ответа) в сессию Яндекса
    const updatedHistory = [
      ...history,
      { role: 'user', parts: [{ text: originalUtterance }] },
      { role: 'model', parts: [{ text: answer }] }
    ].slice(-6);

    return res.status(200).json({
      version,
      session,
      session_state: { history: updatedHistory },
      response: {
        text: answer,
        end_session: false
      }
    });

  } catch (err) {
    console.error('Critical webhook error:', err);
    return res.status(200).json({
      version: req.body?.version || '1.0',
      session: req.body?.session || {},
      response: {
        text: 'Произошел технический сбой в модуле обработки, сэр. Попробуйте еще раз.',
        end_session: false
      }
    });
  }
}
