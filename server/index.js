require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Romaji API Server running' });
});

app.post('/romanize', async (req, res) => {
  const { text } = req.body;
  
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Invalid text provided' });
  }
  
  if (!process.env.HUGGINGFACE_API_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }
  
  try {
    const romanized = await romanizeText(text);
    res.json({ romanized });
  } catch (error) {
    console.error('Romanization error:', error);
    res.status(500).json({ error: error.message || 'Romanization failed' });
  }
});

async function romanizeText(japaneseText) {
  const API_KEY = process.env.HUGGINGFACE_API_KEY;
  const MODEL = 'Xenova/LaMini-Flan-T5-783M';
  const API_URL = `https://api-inference.huggingface.co/models/${MODEL}`;
  
  const prompt = `Convert this Japanese text to romaji (Latin alphabet): ${japaneseText}`;
  
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      inputs: prompt,
      parameters: {
        max_length: 256,
        temperature: 0.1,
        do_sample: false
      }
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HuggingFace API error: ${response.status} - ${errorText}`);
  }
  
  const result = await response.json();
  
  if (Array.isArray(result) && result.length > 0) {
    return result[0].generated_text || result[0].translation_text || text;
  }
  
  throw new Error('Unexpected API response format');
}

app.listen(PORT, () => {
  console.log(`Romaji API Server listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Romanize endpoint: POST http://localhost:${PORT}/romanize`);
});
