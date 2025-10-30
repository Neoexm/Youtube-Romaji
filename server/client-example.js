const ROMAJI_API_URL = 'http://localhost:3000/romanize';

async function romanizeViaAPI(text) {
  try {
    const response = await fetch(ROMAJI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.romanized;
  } catch (error) {
    console.error('[romaji-api] error:', error);
    throw error;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { romanizeViaAPI, ROMAJI_API_URL };
}
