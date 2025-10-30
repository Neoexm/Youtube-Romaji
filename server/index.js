require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Romaji API Server running' });
});

app.post('/romanize', async (req, res) => {
  try {
    const { videoId, text } = req.body;

    if (!videoId || !text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Invalid request. Provide videoId and text.' });
    }

    console.log(`[romanize] videoId: ${videoId}, text length: ${text.length}`);

    const { data: cached, error: cacheError } = await supabase
      .from('romanized_cache')
      .select('romanized_text')
      .eq('video_id', videoId)
      .single();

    if (cached && !cacheError) {
      console.log(`[romanize] cache HIT for ${videoId}`);
      return res.json({ romanized: cached.romanized_text, cached: true });
    }

    console.log(`[romanize] cache MISS for ${videoId}, attempting to acquire lock...`);

    const { data: lockResult, error: lockError } = await supabase
      .from('romanized_cache')
      .insert([{
        video_id: videoId,
        romanized_text: 'PROCESSING',
        created_at: new Date().toISOString()
      }])
      .select();

    if (lockError) {
      if (lockError.code === '23505') {
        console.log(`[romanize] race condition detected for ${videoId}, another request is processing`);
        
        let retries = 0;
        while (retries < 30) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          const { data: retryCheck } = await supabase
            .from('romanized_cache')
            .select('romanized_text')
            .eq('video_id', videoId)
            .single();
          
          if (retryCheck && retryCheck.romanized_text !== 'PROCESSING') {
            console.log(`[romanize] processing complete by another request for ${videoId}`);
            return res.json({ romanized: retryCheck.romanized_text, cached: true });
          }
          
          retries++;
        }
        
        return res.status(408).json({ error: 'Timeout waiting for romanization to complete' });
      }
      
      throw lockError;
    }

    console.log(`[romanize] lock acquired for ${videoId}, calling OpenAI...`);

    try {
      const response = await openai.responses.create({
        prompt: {
          id: 'pmpt_6903b00f45ec81909db49935f61cabc8050221356ced0cef',
          version: '2',
          variables: {
            lyrics: text
          }
        }
      });

      const romanized = response.output_text.trim();

      await supabase
        .from('romanized_cache')
        .update({ romanized_text: romanized })
        .eq('video_id', videoId);

      console.log(`[romanize] cached result for ${videoId}`);

      res.json({ romanized, cached: false });
    } catch (aiError) {
      await supabase
        .from('romanized_cache')
        .delete()
        .eq('video_id', videoId);
      
      throw aiError;
    }
  } catch (error) {
    console.error('[romanize] error:', error);
    res.status(500).json({ error: error.message || 'Romanization failed' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Romaji API Server listening on port ${PORT}`);
  console.log(`OpenAI API Key configured: ${!!process.env.OPENAI_API_KEY}`);
  console.log(`Supabase configured: ${!!process.env.SUPABASE_URL}`);
});
