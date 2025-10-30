const testText = 'こんにちは';

console.log('Testing romanization API...\n');

fetch('http://localhost:3000/romanize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: testText })
})
  .then(res => res.json())
  .then(data => {
    console.log('Input:', testText);
    console.log('Output:', data.romanized);
    console.log('\nSuccess!');
  })
  .catch(err => {
    console.error('Error:', err.message);
  });
