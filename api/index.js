export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  const { request, session, version } = req.body;
  const userText = request?.original_utterance?.trim() || '';

  // Приветствие при старте
  if (session?.new || !userText) {
    return res.json({
      version,
      session,
      response: {
        text: 'Привет! Я слушаю. Задавай любой вопрос — отвечу с помощью нейросети.',
        end_session: false
      }
    });
  }

  // Команды выхода
  if (['хватит', 'стоп', 'выход', 'пока'].includes(userText.toLowerCase())) {
    return res.json({
      version,
      session,
      response: {
        text: 'До связи!',
        end_session: true
      }
    });
  }

  try {
    // 1. Поиск в сети через Serper
    let searchData = '';
    try {
      const searchRes = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: {
          'X-API-KEY': process.env.SERPER_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ q: userText, gl: 'ru', hl: 'ru' })
      });
      const searchJson = await searchRes.json();
      if (searchJson.organic && searchJson.organic.length > 0) {
        searchData = searchJson.organic
          .slice(0, 3)
          .map(item => `${item.title}:${item.snippet}`)
          .join('\n');
      }
    } catch (e) {
      console.error('Ошибка Serper:', e);
    }

    // 2. Запрос в Gemini
    const prompt = `Ты — ДЖАРВИС (J.A.R.V.I.S.), искусственный интеллект Тони Старка из Железного человека.
Общайся с пользователем вежливо, как верный дворецкий и высокотехнологичный ассистент (можешь называть пользователя «сэр»). 
Отвечай емко, кратко (1-3 предложения), разговорной речью без разметки Markdown, звездочек и спецсимволов.
Актуальные факты из поиска:
${searchData || 'Нет данных'}

Вопрос пользователя: ${userText}`;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    const geminiJson = await geminiRes.json();
    let reply = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text || 'Не удалось получить ответ от нейросети.';
    reply = reply.replace(/[*#_`>]/g, '').trim();

    return res.json({
      version,
      session,
      response: {
        text: reply,
        end_session: false
      }
    });
  } catch (error) {
    console.error('Ошибка выполнения:', error);
    return res.json({
      version,
      session,
      response: {
        text: 'Произошла ошибка при обработке запроса.',
        end_session: false
      }
    });
  }
}
