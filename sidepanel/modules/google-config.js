// ── google-config.js ───────────────────────────────────────────────────────
// Identificadores do projeto no Google Cloud.
//
// Client ID NÃO é segredo: ele viaja na URL de autorização, aparece no código
// da página e está no manifesto da extensão. O que é segredo é o client
// secret — e ele não existe aqui de propósito. Extensão e PWA são clientes
// PÚBLICOS: não conseguem guardar segredo nenhum, e é exatamente para esse
// caso que o PKCE existe. Se algum dia aparecer um `client_secret` neste
// arquivo, é erro.

export const GOOGLE_CLIENT_ID_WEB =
  '324044251913-omlvbssk3av45rafji6evt6kmlev22pf.apps.googleusercontent.com';

export const GOOGLE_CLIENT_ID_EXTENSAO =
  '324044251913-1ftlbp9ip7g9mhv3iuum47hl0tuq41md.apps.googleusercontent.com';

// `drive.file` dá acesso SÓ aos arquivos que este app criou ou que a pessoa
// escolheu explicitamente. Não é só boa vizinhança: é o que mantém o projeto
// fora da categoria de escopo restrito do Google, que exige auditoria de
// segurança anual paga. Trocar isto por `drive` inviabiliza o app.
export const GOOGLE_ESCOPO = 'https://www.googleapis.com/auth/drive.file';

// Nome da pasta criada no Drive da pessoa. Fica na raiz, visível, porque o
// ponto desta arquitetura é ela conseguir abrir e ler as próprias notas sem
// o QuickDock.
export const PASTA_RAIZ = 'QuickDock';
