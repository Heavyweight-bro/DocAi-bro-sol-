import http from 'http';

const req = http.request('http://localhost:3000/api/unknown', { method: 'POST' }, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log('STATUS:', res.statusCode);
    console.log('HEADERS:', res.headers);
    console.log('BODY:', data.substring(0, 100));
  });
});
req.on('error', (err) => {
  console.error('Error:', err.message);
});
req.end();
