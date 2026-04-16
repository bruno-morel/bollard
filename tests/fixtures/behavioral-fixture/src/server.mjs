import http from "node:http"

void process.env.DATABASE_URL
void process.env.PORT

const port = Number(process.env.PORT ?? 3000)

http
  .createServer((req, res) => {
    if (req.url === "/api/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ status: "ok" }))
      return
    }
    if (req.url === "/api/data" && req.method === "POST") {
      res.writeHead(201)
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  .listen(port)
