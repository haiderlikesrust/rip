import { config } from './config';

const secrets = () => [config.SOLANA_RPC_URL, config.DAS_RPC_URL, config.JUPITER_API_KEY, config.COLLECTOR_CRYPT_API_KEY, config.DATABASE_URL, config.OPS_PRIVATE_KEY, config.TREASURY_PRIVATE_KEY]
  .filter((value): value is string => !!value && value.length >= 8);

/**
 * Makes an error message safe to show a visitor or write to logs: configured secrets, URLs (RPC
 * endpoints often carry API keys) and key=value credentials are removed, and length is bounded.
 */
export function redact(message: string) {
  let out = String(message ?? '');
  for (const secret of secrets()) out = out.split(secret).join('[redacted]');
  out = out.replace(/(?:https?|postgres(?:ql)?|wss?):\/\/[^\s'"<>]+/gi, '[link]')
    .replace(/\b(api[-_]?key|access[-_]?token|token|secret|password)=([^&\s'"]+)/gi, '$1=[redacted]');
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

/** Programming errors and failed network calls never show their raw text to visitors. */
export function publicError(error: Error & { statusCode?: number }) {
  if (error.statusCode) return { status: error.statusCode, message: redact(error.message) };
  if (error instanceof TypeError && /fetch failed|network/i.test(error.message)) return { status: 503, message: 'A service we depend on is unavailable right now. Please try again shortly.' };
  if (error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError || error instanceof SyntaxError) return { status: 500, message: 'Something went wrong. Please try again.' };
  return { status: 400, message: redact(error.message) };
}
