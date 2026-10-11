export default async function handler(req, res) {
  // Обработка предварительных CORS-запросов OPTIONS
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // На случай GET-проверок
  if (req.method !== 'POST') {
    return res.status(200).send('OK');
  }

  const body = req.body || {};
  const version = body.version || '2.0';
  const session = body.session || {};
  const text = body.request?.original_utterance || 'Слушаю вас, сэр!';

  return res.status(200).json({
    version,
    session,
    response: {
      text: `Джарвис на связи! Вы сказали: ${text}`,
      end_session: false
    }
  });
}
