import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

// ... [Mantenha a função buildServer() e o resto do código intactos] ...

const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-mcp-version"]
}));

app.use(express.json({ limit: "5mb" }));

// Armazena as conexões SSE ativas em memória
const transports = new Map();

// Endpoint GET para inicializar o canal SSE do GPT Maker
app.get("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new SSEServerTransport("/messages", res);
    
    transports.set(transport.sessionId, { server, transport });

    res.on("close", () => {
      transport.close();
      server.close();
      transports.delete(transport.sessionId);
    });

    await server.connect(transport);
  } catch (err) {
    console.error("Erro ao iniciar SSE:", err);
    if (!res.headersSent) {
      res.status(500).send("Erro ao iniciar conexão SSE");
    }
  }
});

// Endpoint POST para receber os comandos enviados pelo GPT Maker
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = transports.get(sessionId);

  if (!session) {
    return res.status(404).send("Sessão MCP não encontrada");
  }

  await session.transport.handlePostMessage(req, res);
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/", (_req, res) => res.json({ status: "ok", service: "Eprom MCP Server" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor MCP Eprom SSE rodando na porta ${PORT}`);
});
