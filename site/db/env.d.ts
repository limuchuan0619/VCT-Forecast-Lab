declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    DEEPSEEK_API_KEY?: string;
    DEEPSEEK_MODEL?: string;
    AUTOMATION_INGEST_KEY?: string;
  }
}
