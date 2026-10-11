export default async function handler(req, res) {
  // Яндекс Диалоги проверяют доступность эндпоинта или отправляют POST
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  // Безопасно парсим тело запроса
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = {};
    }
  }

  const version = body?.version || '2.0';
  const session = body?.session || {};
  const userText = body?.request?.original_utterance?.trim() || '';

  // 1. Приветствие при старте навыка
  if (session?.new || !userText) {
    return res.status(200).json({
      version,
      session,
      response: {
        text: 'Слушаю вас, сэр. Джарвис готов к работе.',
        end_session: false
      }
    });
  }

  // 2. Команды выхода
  if (['хватит', 'стоп', 'выход', 'пока'].includes(userText.toLowerCase())) {
    return res.status(200).json({
      version,
      session,
      response: {
        text: 'Всегда к вашим услугам, сэр.',
        end_session: true
      }
    });
  }

  try {
    // 3. Поиск через Serper с жестким таймаутом 2 сек, чтобы уложиться в лимит Алисы
    let searchData = '';
    try {
      if (process.env.SERPER_API_KEY) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);

        const searchRes = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'X-API-KEY': process.env.SERPER_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ q: userText, gl: 'ru', hl: 'ru' })
        });
        clearTimeout(timeout);

        if (searchRes.ok) {
          const searchJson = await searchRes.json();
          if (searchJson.organic && searchJson.organic.length > 0) {
            searchData = searchJson.organic
              .slice(0, 2)
              .map(item => `${item.title}:${item.snippet}`)
              .join('\n');
          }
        }
      }
    } catch (e) {
      console.error('Ошибка Serper:', e.message);
    }

    // 4. Запрос к Gemini
    const prompt = `Ты — ДЖАРВИС (J.A.R.V.I.S.), голосовой помощник и дворецкий Тони Старка.
Обращайся к пользователю вежливо, как верный ассистент (можешь называть «сэр»).
Отвечай емко, строго для голосового воспроизведения: не более 1-3 предложений, без форматирования Markdown, без списков, звездочек и скобок.

Актуальная информация из поиска:
${searchData || 'Нет данных'}

Вопрос пользователя: ${userText}`;

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    
    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });

    let replyText = 'Сэр, мне не удалось обработать ваш запрос.';

    if (geminiRes.ok) {
      const geminiJson = await geminiRes.json();
      const rawText = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text;
      if (rawText) {
        // Очищаем от спецсимволов markdown
        replyText = rawText.replace(/[*#_`>]/g, '').trim();
      }
    } else {
      const errText = await geminiRes.text();
      console.error('Ошибка Gemini API:', errText);
    }

    return res.status(200).json({
      version,
      session,
      response: {
        text: replyText,
        end_session: false
      }
    });

  } catch (error) {
    console.error('Критическая ошибка:', error);
    return res.status(200).json({
      version,
      session,
      response: {
        text: 'Сэр, произошла непредвиденная ошибка протокола.',
        end_session: false
      }
    });
  }
}
