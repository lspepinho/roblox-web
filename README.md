# roblox-web

IWA e fallback web do Roblox WebClient, com o mesmo engine patched, RUPP e
perfil de performance. O servidor único serve o site, a API autenticada e o
proxy WebSocket ↔ UDP.

## Conteúdo

- `apps/iwa/` — versão Isolated Web App atual, incluindo engine, glue e assets.
- `apps/site/` — fallback para navegador comum, com formulário de login.
- `server/` — serviço Node.js para Render, sem banco de dados.
- `render.yaml` — Blueprint de deploy.
- `docs/DEPLOY.md` — instruções para colocar no ar.

## Arquitetura

```text
Browser/IWA                         Render
┌─────────────────┐          HTTPS  ┌──────────────────────┐
│ WasmPlayer      │ <──────────────>│ Static + COOP/COEP   │
│ rbx-net         │ <──────────────>│ /api/rbx + /api/join │
│ ring + RUPP     │ <── WebSocket ─>│ UDP por sessão       │
└─────────────────┘   binário       └──────────────────────┘
```

Na IWA, `ring.js` continua usando `UDPSocket`. No site, o mesmo contrato é
implementado por `transport-websocket.js`. O proxy só aceita o endpoint obtido
no join da sessão; não é um relay UDP aberto.

## Rodar localmente

Requisitos: Node.js 20 ou superior (22 recomendado).

```bash
cd server
npm ci
npm start
```

Abra <http://localhost:3000/>. Na execução local, o Node abre essa página
automaticamente (desative com `AUTO_OPEN=0`). Todas as páginas de entrada exigem
Basic Auth e os endereços antigos redirecionam para a raiz.

1. No prompt nativo do navegador, entre com `admin/admin` no proxy.
2. Na própria raiz, informe usuário e senha da sua conta Roblox.
3. A página oficial aparece num **iframe proxy**, com formulário, captcha e 2FA
   funcionando no próprio navegador. O proxy só encaminha login e recursos de
   captcha; o cookie é obtido automaticamente. O cookie manual também fica na
   mesma página.
4. Informe o Place ID e clique em **Entrar no jogo**.
5. O cliente abre em uma aba `about:blank`. Se o navegador bloquear a primeira
   abertura, clique em **Abrir cliente**. A aba inicial permanece na tela de
   Place ID; ao entrar, o cliente usa `about:blank?placeId=...` e, ao sair, ele
   fecha e retorna à tela inicial.

Não é necessário colar `.ROBLOSECURITY`. Suas credenciais Roblox são usadas
apenas para esse login local e não são registradas. O cookie fica apenas na
memória do servidor e o token fica em `sessionStorage`.

No Render, o formulário manual continua disponível porque o servidor não consegue
abrir um navegador no seu computador. Nesse caso, informe o cookie manualmente;
admin/admin não vem preenchido. Não há banco de dados nem log de cookies/tokens.

## Testes

Na raiz:

```bash
npm test
```

Cobre scrypt, allowlist de URLs, join nativo, headers de isolamento, árvore de
assets e um datagrama UDP real atravessando o WebSocket.

## Publicar no Render

Siga **[docs/DEPLOY.md](docs/DEPLOY.md)**. O Blueprint usa:

```text
build: npm ci --prefix server
start: npm start --prefix server
health: /health
```

O deploy precisa ser confirmado na sua conta Render; este repositório não faz
publicação automática.

## Performance

O padrão atual é:

- `DFIntTaskSchedulerTargetFps=240`, sem cap específico por plataforma;
- FRM 1, MSAA 0 e texturas com 4 mips pulados;
- `renderScale=0.625` nos dois ambientes;
- mixer por AudioWorklet, com fallback de 4096 frames.

Para resolução nativa:

```js
localStorage.setItem("weblox.renderScale", "1");
location.reload();
```

Para outro valor:

```js
localStorage.setItem("weblox.renderScale", "0.5");
location.reload();
```

FFlags ficam em `apps/iwa/fflags.json`. Um objeto em
`localStorage["weblox.fflags"]` é aplicado sobre esse perfil.

## Segurança

- scrypt para a senha do proxy (`admin/admin` por padrão);
- tokens aleatórios de 32 bytes, com expiração de uma hora;
- token WebSocket em `Sec-WebSocket-Protocol`, nunca na query string;
- CORS não é liberado para origens externas;
- rate limit de login e limite de payload WebSocket;
- UDP somente para os endpoints do join;
- cookie Roblox somente em memória.

`admin/admin` é uma senha pública de conveniência. Para uso público prolongado,
gere outra com `npm run hash -- <usuario> <senha>` dentro de `server/` e altere
as variáveis de ambiente no Render.
