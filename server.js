import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------
const API_BASE_URL = process.env.EPROM_API_BASE_URL || "https://open-api.eprom.com.br/api";
const PORT = process.env.PORT || 3000;

const DEFAULT_EMAIL = process.env.EPROM_EMAIL || null;
const DEFAULT_SENHA = process.env.EPROM_SENHA || null;

// ---------------------------------------------------------------------------
// Estado de autenticação (em memória - processo único)
// ---------------------------------------------------------------------------
const authState = {
  accessToken: null,
  accessTokenExpiration: null,
  refreshToken: null,
  refreshTokenExpiration: null,
};

function isExpired(iso) {
  if (!iso) return true;
  return new Date(iso).getTime() <= Date.now() + 5000;
}

async function login(email, senha) {
  const resp = await fetch(`${API_BASE_URL}/Auth/Login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, senha }),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(
      `Falha no login (HTTP ${resp.status}): ${JSON.stringify(data)}`
    );
  }

  authState.accessToken = data.access_token;
  authState.accessTokenExpiration = data.access_token_expiration;
  authState.refreshToken = data.refresh_token;
  authState.refreshTokenExpiration = data.refresh_token_expiration;

  return data;
}

async function ensureAuthenticated() {
  if (authState.accessToken && !isExpired(authState.accessTokenExpiration)) {
    return;
  }
  if (DEFAULT_EMAIL && DEFAULT_SENHA) {
    await login(DEFAULT_EMAIL, DEFAULT_SENHA);
    return;
  }
  throw new Error(
    "Não autenticado. Chame a ferramenta 'eprom_login' com email e senha, " +
      "ou defina as variáveis de ambiente EPROM_EMAIL e EPROM_SENHA no servidor."
  );
}

async function epromFetch(method, path, { query, body } = {}) {
  await ensureAuthenticated();

  const url = new URL(
    path.startsWith("http") ? path : `${API_BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`
  );

  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }

  const resp = await fetch(url.toString(), {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${authState.accessToken}`,
    },
    body: body !== undefined && method !== "GET" && method !== "DELETE"
      ? JSON.stringify(body)
      : undefined,
  });

  const text = await resp.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return { status: resp.status, ok: resp.ok, data };
}

function toolResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Servidor MCP e ferramentas
// ---------------------------------------------------------------------------
function buildServer() {
  const server = new McpServer({
    name: "eprom-esolution-mcp",
    version: "1.0.0",
  });

  // -- Autenticação -----------------------------------------------------
  server.registerTool(
    "eprom_login",
    {
      title: "Login na API Eprom",
      description:
        "Autentica na Open API do ERP E-Solution (Eprom TI Informática) usando email e senha, e guarda o token de acesso para as próximas chamadas.",
      inputSchema: {
        email: z.string().describe("E-mail de login cadastrado no sistema"),
        senha: z.string().describe("Senha de login"),
      },
    },
    async ({ email, senha }) => {
      try {
        const data = await login(email, senha);
        return toolResult({
          message: "Login realizado com sucesso.",
          access_token_expiration: data.access_token_expiration,
          refresh_token_expiration: data.refresh_token_expiration,
        });
      } catch (err) {
        return toolResult({ error: String(err.message || err) });
      }
    }
  );

  // -- Ferramenta genérica ----------------------------------------------
  server.registerTool(
    "eprom_request",
    {
      title: "Chamada genérica à API Eprom",
      description:
        "Faz uma chamada a qualquer endpoint da Open API do ERP E-Solution (Eprom).",
      inputSchema: {
        method: z
          .enum(["GET", "POST", "PUT", "DELETE"])
          .describe("Método HTTP do endpoint"),
        path: z
          .string()
          .describe(
            "Caminho do endpoint relativo à API, ex: '/Despesa', '/Pagamento/123'"
          ),
        query: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Parâmetros de query string para GET"),
        body: z
          .any()
          .optional()
          .describe("Corpo JSON para POST/PUT"),
      },
    },
    async ({ method, path, query, body }) => {
      try {
        const result = await epromFetch(method, path, { query, body });
        return toolResult(result);
      } catch (err) {
        return toolResult({ error: String(err.message || err) });
      }
    }
  );

  // -- Atalhos ----------------------------------------------------------
  const shortcut = (name, title, description, path) => {
    server.registerTool(
      name,
      {
        title,
        description,
        inputSchema: {
          method: z.enum(["GET", "POST", "PUT", "DELETE"]).describe("Método HTTP"),
          id: z
            .union([z.string(), z.number()])
            .optional()
            .describe("ID do registro"),
          query: z
            .record(z.union([z.string(), z.number(), z.boolean()]))
            .optional()
            .describe("Filtros de busca para GET"),
          body: z.any().optional().describe("Payload para POST/PUT"),
        },
      },
      async ({ method, id, query, body }) => {
        try {
          const fullPath = id ? `${path}/${id}` : path;
          const result = await epromFetch(method, fullPath, { query, body });
          return toolResult(result);
        } catch (err) {
          return toolResult({ error: String(err.message || err) });
        }
      }
    );
  };

  shortcut("eprom_despesa", "Despesas", "Cria, lista, altera ou exclui Despesas.", "/Despesa");
  shortcut("eprom_pagamento", "Pagamentos", "Cria/estorna pagamentos.", "/Pagamento");
  shortcut("eprom_recebimento", "Recebimentos", "Cria/estorna recebimentos.", "/Recebimento");
  shortcut("eprom_entrada_mercadoria", "Entrada de Mercadorias", "Gestão de compras.", "/EntradaMercadoria");
  shortcut("eprom_fatura", "Faturas", "Cria, lista, altera ou exclui Faturas.", "/Fatura");
  shortcut("eprom_pedido_venda", "Pedidos de Venda", "Cria, lista, altera ou exclui Pedidos de Venda.", "/PedidoVenda");
  shortcut("eprom_entidade", "Entidades", "Gestão de Clientes e Fornecedores.", "/Entidade");
  shortcut("eprom_produto", "Produtos", "Gestão de Produtos.", "/Produto");

  return server;
}

// ---------------------------------------------------------------------------
// Configuração do Express com CORS e Transporte MCP
// ---------------------------------------------------------------------------
const app = express();

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "x-mcp-version", "mcp-session-id"]
}));

app.use(express.json({ limit: "5mb" }));

// Handler MCP genérico para aceitar chamadas GET e POST do client
const handleMcpRequest = async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Erro no /mcp:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Erro interno do servidor" },
        id: null,
      });
    }
  }
};

app.post("/mcp", handleMcpRequest);
app.get("/mcp", handleMcpRequest);
app.options("/mcp", (req, res) => res.sendStatus(200));

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/", (_req, res) => res.json({ status: "ok", service: "Eprom MCP Server" }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor MCP Eprom rodando na porta ${PORT}`);
});
