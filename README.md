# Servidor MCP – Integração com ERP E-Solution (Eprom)

Servidor MCP em Node.js, usando transporte **Streamable HTTP**, que integra
com a Open API do ERP E-Solution documentada em
https://docs-openapi.eprom2.com.br (endpoint base:
`https://open-api.eprom.com.br/api`).

## O que ele expõe

- **eprom_login** – autentica na API (email + senha) e guarda o token.
- **eprom_request** – ferramenta genérica: chama qualquer endpoint da API
  (Notas, Pedidos, Equipamentos, tabelas de apoio, etc.), passando
  `method`, `path`, `query` e `body`. Cobre 100% da API mesmo sem uma
  ferramenta dedicada.
- Atalhos prontos para os recursos mais usados:
  `eprom_despesa`, `eprom_pagamento`, `eprom_recebimento`,
  `eprom_entrada_mercadoria`, `eprom_fatura`, `eprom_pedido_venda`,
  `eprom_entidade`, `eprom_produto`.

O servidor renova/gera o token automaticamente antes de cada chamada, se
necessário.

## 1. Instalar dependências

```bash
npm install
```

## 2. Configurar credenciais (opcional, mas recomendado)

Para não precisar chamar `eprom_login` manualmente toda vez, defina as
variáveis de ambiente com um usuário de integração do E-Solution:

```bash
export EPROM_EMAIL="email@dominio.com.br"
export EPROM_SENHA="senha123"
```

Se preferir, deixe sem essas variáveis e chame a ferramenta `eprom_login`
manualmente (a IA que consumir o MCP pode fazer isso na primeira interação).

## 3. Rodar localmente (teste)

```bash
npm start
# Servidor MCP Eprom rodando em http://localhost:3000/mcp
```

## 4. Publicar (para usar no formulário "Conectar servidor MCP")

O formulário da imagem pede uma **URL pública** (tipo "Streamable Http"), então
você precisa hospedar este servidor em algum lugar acessível pela internet.
Opções simples:

- **Railway / Render / Fly.io**: suba este repositório, defina
  `EPROM_EMAIL` e `EPROM_SENHA` como variáveis de ambiente do serviço, e
  ele expõe algo como `https://seu-app.up.railway.app`.
- **VPS próprio**: rode com `pm2` ou `systemd` atrás de um Nginx com HTTPS.

A URL final do servidor MCP será:

```
https://SEU-DOMINIO/mcp
```

## 5. Preencher o formulário "Conectar servidor MCP"

- **Nome**: Eprom E-Solution
- **Descrição**: Integração com o ERP E-Solution (Eprom) — despesas, pagamentos, recebimentos, entradas, faturas, pedidos, entidades e produtos.
- **Tipo**: Streamable Http
- **URL do servidor MCP**: `https://SEU-DOMINIO/mcp`
- **Autenticação**: como a API da Eprom usa login por email/senha (não OAuth),
  deixe a autenticação do MCP como "Nenhuma"/sem OAuth e use a ferramenta
  `eprom_login` (ou as variáveis de ambiente `EPROM_EMAIL`/`EPROM_SENHA`)
  para autenticar contra a API da Eprom.

## Observações de segurança

- Este servidor guarda o token em memória, no processo do servidor (não é
  multiusuário/multi-tenant). Se vários clientes diferentes forem usar o
  mesmo servidor com credenciais diferentes, adapte `authState` para guardar
  o token por sessão MCP (usando o `sessionId` do transporte) em vez de uma
  única variável global.
- Nunca commite `EPROM_EMAIL`/`EPROM_SENHA` no código; use variáveis de
  ambiente do provedor de hospedagem.
- Endpoints de exclusão (`DELETE`) e alteração (`PUT`/`POST`) executam ações
  reais no ERP — considere restringir quais ferramentas ficam disponíveis
  se quiser um acesso só de leitura.
