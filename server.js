import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------
const API_BASE_URL = process.env.EPROM_API_BASE_URL || "https://open-api.eprom.com.br/api";
const PORT = process.env.PORT || 3000;

// Credenciais padrão (opcional). Se definidas, o servidor tenta logar sozinho
// na primeira chamada, sem precisar que o usuário chame eprom_login antes.
const DEFAULT_EMAIL = process.env.EPROM_EMAIL || null;
const DEFAULT_SENHA = process.env.EPROM_SENHA || null;

// ---------------------------------------------------------------------------
// Estado de autenticação (em memória - processo único).
// Para uso multi-tenant sério, troque isso por um cache por sessão/usuário.
// ---------------------------------------------------------------------------
const authState = {
  accessToken: null,
  accessTokenExpiration: null,
  refreshToken: null,
  refreshTokenExpiration: null,
};

function isExpired(iso) {
  if (!iso) return true;
  return new Date(iso).getTime() <= Date.now() + 5000; // 5s de folga
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
  // TODO: a API expõe apenas /Auth/Login na documentação capturada.
  // Se houver endpoint de refresh, ele pode ser adicionado aqui usando
  // authState.refreshToken antes de cair para o login por email/senha.
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

  // -- Ferramenta genérica (cobre qualquer endpoint da API) --------------
  server.registerTool(
    "eprom_request",
    {
      title: "Chamada genérica à API Eprom",
      description:
        "Faz uma chamada a qualquer endpoint da Open API do ERP E-Solution (Eprom). " +
        "Use isso para qualquer recurso não coberto pelas ferramentas de atalho: " +
        "Pagamento, Recebimento, Despesa, Despesa/Item, Despesa/Parcelamento, " +
        "EntradaMercadoria, EntradaMercadoria/Item, EntradaMercadoria/Parcelamento, " +
        "Fatura, Fatura/Item, Fatura/Parcelamento, NotaEmitida, NotaRecebida, " +
        "PedidoVenda, PedidoVenda/Item, PedidoVenda/Parcelamento, Entidade, " +
        "Entidade/Endereco, Entidade/Contato, Entidade/Documento, Entidade/Tipo, " +
        "Entidade/Vinculo, Equipamento, Produto, Produto/Descricao, Produto/Imagem, " +
        "GrupoProduto, LinhaProduto, MarcaProduto, UnidadeMedida, FormaPagamento, " +
        "entre outros descritos na documentação https://docs-openapi.eprom2.com.br. " +
        "Para GET, use 'query' com os parâmetros de filtro (id, page, size, etc). " +
        "Para POST/PUT, use 'body' com o payload em JSON. Autentica automaticamente se necessário.",
      inputSchema: {
        method: z
          .enum(["GET", "POST", "PUT", "DELETE"])
          .describe("Método HTTP do endpoint"),
        path: z
          .string()
          .describe(
            "Caminho do endpoint relativo à API, ex: '/Despesa', '/Pagamento/123', '/Entidade/Endereco'"
          ),
        query: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Parâmetros de query string para GET (ex: {id: 123, page: 1, size: 10})"),
        body: z
          .any()
          .optional()
          .describe("Corpo JSON para POST/PUT, conforme o schema do endpoint"),
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

  // -- Atalhos para os recursos mais usados -------------------------------
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
            .describe("ID do registro (necessário para GET por id, PUT e DELETE)"),
          query: z
            .record(z.union([z.string(), z.number(), z.boolean()]))
            .optional()
            .describe("Filtros de busca para GET (page, size, status, etc)"),
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

  shortcut(
    "eprom_despesa",
    "Despesas",
    "Cria, lista, altera ou exclui Despesas (tipo IMPOSTO, DESPESA ou NF) no ERP E-Solution.",
    "/Despesa"
  );
  shortcut(
    "eprom_pagamento",
    "Pagamentos (contas a pagar)",
    "Cria/estorna pagamentos e lista baixas do contas a pagar.",
    "/Pagamento"
  );
  shortcut(
    "eprom_recebimento",
    "Recebimentos (contas a receber)",
    "Cria/estorna recebimentos e lista baixas do contas a receber.",
    "/Recebimento"
  );
  shortcut(
    "eprom_entrada_mercadoria",
    "Entrada de Mercadorias",
    "Cria, lista, altera ou exclui Entradas de Mercadorias (compras).",
    "/EntradaMercadoria"
  );
  shortcut(
    "eprom_fatura",
    "Faturas",
    "Cria, lista, altera ou exclui Faturas.",
    "/Fatura"
  );
  shortcut(
    "eprom_pedido_venda",
    "Pedidos de Venda",
    "Cria, lista, altera ou exclui Pedidos de Venda.",
    "/PedidoVenda"
  );
  shortcut(
    "eprom_entidade",
    "Entidades (clientes/fornecedores)",
    "Cria, lista, altera ou exclui Entidades (clientes, fornecedores, funcionários, etc).",
    "/Entidade"
  );
  shortcut(
    "eprom_produto",
    "Produtos",
    "Cria, lista, altera ou exclui Produtos.",
    "/Produto"
  );

  return server;
}

// ---------------------------------------------------------------------------
// Express + transporte Streamable HTTP (modo stateless: uma sessão por request)
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "5mb" }));

app.post("/mcp", async (req, res) => {
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
});

// GET/DELETE em /mcp não são usados neste modo stateless simples.
app.get("/mcp", (_req, res) => res.status(405).send("Method Not Allowed"));
app.delete("/mcp", (_req, res) => res.status(405).send("Method Not Allowed"));

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Servidor MCP Eprom rodando em http://localhost:${PORT}/mcp`);
});
