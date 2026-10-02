import { z } from 'zod';

/**
 * Configuração validada na inicialização.
 * O processo NÃO sobe com configuração inválida — falhar cedo e alto é melhor
 * que descobrir em produção que a chave de assinatura estava vazia.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1),

  /**
   * Chave de assinatura dos access tokens.
   * Em produção é um par Ed25519 vindo do secret manager (ADR-0005).
   * Em dev/test, um par é gerado na inicialização — nunca há segredo no código.
   */
  JWT_PRIVATE_KEY_PEM: z.string().optional(),
  JWT_PUBLIC_KEY_PEM: z.string().optional(),
  JWT_ISSUER: z.string().default('https://api.plataforma.local'),
  JWT_AUDIENCE: z.string().default('plataforma-api'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

  /** Chave mestra para envelope encryption da chave Pix. Em produção: KMS. */
  DATA_ENCRYPTION_KEY: z.string().optional(),
  /** Pepper aplicado por HMAC antes do Argon2 (ver docs/07 §5). */
  PASSWORD_PEPPER: z.string().optional(),

  MEDIA_STORAGE_DIR: z.string().default('./var/media'),
  MEDIA_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),

  /**
   * Provedores externos. Ausentes => adapter de registro (LoggingProvider),
   * que NÃO finge que a operação aconteceu: marca a notificação como SKIPPED
   * com motivo PROVIDER_NOT_CONFIGURED.
   */
  /**
   * Endereço público do sistema (ex.: https://pedidos.minhaloja.com.br). Quando
   * definido e público, é a base do link e do QR code do cardápio. O launcher o
   * preenche com o IP da rede local, que só vale dentro do Wi-Fi da loja.
   */
  PUBLIC_BASE_URL: z.string().optional(),
  /**
   * SÓ PARA TESTES: deixa a verificação do link alcançar a rede local. Recusado
   * em produção (ver superRefine abaixo) — em produção essa verificação é uma
   * chamada feita pelo servidor a um endereço informado por um usuário.
   */
  PUBLIC_URL_PROBE_ALLOW_PRIVATE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  WHATSAPP_PROVIDER: z.enum(['META_CLOUD_API', 'LOGGING']).default('LOGGING'),
  WHATSAPP_API_BASE_URL: z.string().default('https://graph.facebook.com/v21.0'),
  PUSH_PROVIDER: z.enum(['EXPO', 'LOGGING']).default('LOGGING'),
  EXPO_PUSH_URL: z.string().default('https://exp.host/--/api/v2/push/send'),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production') {
    // Sem estas duas, o sistema "funciona" até o primeiro reinício e então perde
    // o acesso ao que gravou: sem DATA_ENCRYPTION_KEY a chave é efêmera (a chave
    // Pix e o token do Mercado Pago ficam ilegíveis); sem PASSWORD_PEPPER os
    // hashes gravados deixam de conferir (ninguém consegue entrar). Falhar na
    // partida é melhor do que descobrir isso com a loja aberta.
    for (const name of ['DATA_ENCRYPTION_KEY', 'PASSWORD_PEPPER'] as const) {
      const value = env[name];
      if (!value || value.length < 16) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: 'é obrigatória em produção (mínimo de 16 caracteres) e não pode mudar entre reinícios',
        });
      }
    }
  }
  if (env.NODE_ENV === 'production' && env.PUBLIC_URL_PROBE_ALLOW_PRIVATE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PUBLIC_URL_PROBE_ALLOW_PRIVATE'],
      message: 'não pode ser ativado em produção',
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Configuração inválida:\n${issues.join('\n')}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
