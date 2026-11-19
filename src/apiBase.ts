const configured = (import.meta.env.VITE_API_BASE as string | undefined)?.trim() ?? '';

/**
 * Base URL for the LangChain API.
 * Empty in local development, where Vite proxies /api to the API server.
 * Set VITE_API_BASE to the deployed API origin (for example
 * https://langchain-api.onrender.com) when the frontend is hosted separately.
 */
export const API_BASE = configured.replace(/\/+$/, '');

export function api(path: string) {
  return `${API_BASE}${path}`;
}
