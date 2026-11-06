const http = require('node:http');

http
  .createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (!['/', '/health', '/hello', '/world'].includes(req.url)) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    res.end(
      JSON.stringify({
        status: 'OK',
        message: 'Hello from the ECS native deployment demo!',
        commit: process.env.RELEASE_COMMIT,
      }),
    );
  })
  .listen(3000, '0.0.0.0');
