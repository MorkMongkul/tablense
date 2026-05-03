const sharp = require('sharp');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;

    const { imageBase64, mimeType, model, provider, outputFormat, extraPrompt, defaultPrompt, promptOverride, vision } = req.body || {};
    if (!imageBase64 || !model) {
      res.status(400).json({ error: 'Missing image or model' });
      return;
    }

    const fullPrompt = promptOverride || buildPrompt(outputFormat || 'table', extraPrompt, defaultPrompt);
    const providerName = provider || 'gemini';
    const maxDim = providerName === 'nvidia' ? 1000 : 1600;
    const processed = await preprocessImage(Buffer.from(imageBase64, 'base64'), mimeType || 'image/jpeg', maxDim);

    if (providerName === 'groq') {
      const groqKey = process.env.GROQ_API_KEY;
      if (!groqKey) {
        res.status(500).json({ error: 'Missing GROQ_API_KEY' });
        return;
      }

      const dataUrl = `data:image/png;base64,${processed.toString('base64')}`;
      const groqBody = {
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: fullPrompt },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }
        ],
        temperature: 0.05,
        max_tokens: 8192
      };

      const groqResp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqKey}`
        },
        body: JSON.stringify(groqBody)
      });

      const groqData = await groqResp.json();
      if (!groqResp.ok) {
        const msg = groqData?.error?.message || `HTTP ${groqResp.status}`;
        res.status(groqResp.status).json({ error: msg });
        return;
      }

      const raw = groqData?.choices?.[0]?.message?.content || '';
      res.status(200).json({ raw });
      return;
    }

    if (providerName === 'gcv') {
      const gcvKey = process.env.GOOGLE_VISION_API_KEY || process.env.API_KEY;
      if (!gcvKey) {
        res.status(500).json({ error: 'Missing GOOGLE_VISION_API_KEY or API_KEY' });
        return;
      }

      const gcvBody = {
        requests: [
          {
            image: { content: processed.toString('base64') },
            features: [
              { type: 'DOCUMENT_TEXT_DETECTION' },
              { type: 'TEXT_DETECTION' }
            ]
          }
        ]
      };

      const gcvResp = await fetch(
        `https://vision.googleapis.com/v1/images:annotate?key=${gcvKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(gcvBody)
        }
      );

      const gcvData = await gcvResp.json();
      if (!gcvResp.ok) {
        const msg = gcvData?.error?.message || `HTTP ${gcvResp.status}`;
        res.status(gcvResp.status).json({ error: msg });
        return;
      }

      const resp0 = (gcvData?.responses || [])[0] || {};
      const raw = resp0?.fullTextAnnotation?.text
        || (resp0?.textAnnotations && resp0.textAnnotations[0] && resp0.textAnnotations[0].description)
        || '';

      res.status(200).json({ raw });
      return;
    }

    if (providerName === 'nvidia') {
      const nvKey = process.env.NVIDIA_API_KEY;
      if (!nvKey) {
        res.status(500).json({ error: 'Missing NVIDIA_API_KEY' });
        return;
      }

      if (vision === false) {
        res.status(400).json({ error: 'Selected NVIDIA model is text-only and does not support images.' });
        return;
      }

      const dataUrl = `data:image/png;base64,${processed.toString('base64')}`;
      const nvBody = {
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: fullPrompt },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }
        ],
        temperature: 0.05,
        max_tokens: 2048
      };

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${nvKey}`
      };

      const result = await callChatCompletions('https://integrate.api.nvidia.com/v1', headers, nvBody, 120000);
      if (!result.ok) {
        res.status(result.status || 502).json({ error: result.error });
        return;
      }

      res.status(200).json({ raw: result.raw, model });
      return;
    }

    if (!apiKey) {
      res.status(500).json({ error: 'Missing GEMINI_API_KEY' });
      return;
    }

    const body = {
      contents: [{
        parts: [
          { text: fullPrompt },
          { inline_data: { mime_type: 'image/png', data: processed.toString('base64') } }
        ]
      }],
      generationConfig: { temperature: 0.05, maxOutputTokens: 16384 }
    };

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );

    const data = await resp.json();
    if (!resp.ok) {
      const msg = data?.error?.message || `HTTP ${resp.status}`;
      res.status(resp.status).json({ error: msg });
      return;
    }

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.status(200).json({ raw });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Unexpected error' });
  }
};

function buildPrompt(fmt, extraPrompt, defaultPrompt) {
  const base = {
    table: 'Extract ALL data from this table image. Return ONLY a valid JSON array of row objects, using column headers as keys. Preserve every character exactly — including Khmer, numbers, symbols, arrows (↑↓). No markdown, no explanation, just raw JSON array.',
    json: 'Extract ALL data from this table image. Return ONLY a valid JSON array of row objects, using column headers as keys. Preserve every character exactly. No markdown fences, no explanation — just raw JSON.',
    csv: 'Extract ALL data from this table image. Return ONLY a valid JSON array of row objects, using column headers as keys. Preserve every character exactly — including Khmer, numbers, symbols, arrows (↑↓). No markdown, no explanation, just raw JSON array.'
  };

  const extra = [extraPrompt, defaultPrompt].filter(Boolean).join(' ');
  return base[fmt] + (extra ? '\n\nAdditional: ' + extra : '');
}

async function callChatCompletions(baseUrl, headers, body, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs || 60000);

  let resp;
  try {
    resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    const isTimeout = err && err.name === 'AbortError';
    return {
      ok: false,
      status: isTimeout ? 504 : 502,
      error: isTimeout ? 'Request timed out. Please try again.' : (err.message || 'Request failed.')
    };
  } finally {
    clearTimeout(timeout);
  }

  let data = null;
  try { data = await resp.json(); } catch (e) {}

  if (!resp.ok) {
    const msg = data?.error?.message || `HTTP ${resp.status}`;
    const details = data?.error?.metadata?.raw || data?.error?.metadata?.provider_error;
    const fullMsg = details ? `${msg}: ${details}` : msg;
    return { ok: false, status: resp.status, error: fullMsg };
  }

  const raw = data?.choices?.[0]?.message?.content || '';
  return { ok: true, raw };
}

async function preprocessImage(buffer, mimeType, maxDim) {
  const targetDim = maxDim || 1600;

  let img = sharp(buffer, { failOnError: false, animated: false });
  const meta = await img.metadata();
  const scale = Math.min(1, targetDim / Math.max(meta.width || targetDim, meta.height || targetDim));
  if (scale < 1) {
    img = img.resize({ width: Math.round((meta.width || targetDim) * scale), height: Math.round((meta.height || targetDim) * scale) });
  }

  img = img
    .grayscale()
    .sharpen();

  return img.png().toBuffer();
}
