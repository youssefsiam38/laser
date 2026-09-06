"use client";
/**
 * Provider marks for model-facing surfaces.
 *
 * Artwork comes from the maintained `@lobehub/icons` AI-provider catalog. We
 * deliberately use each component's mono variant: it renders with
 * `currentColor`, so Laser's theme tokens retain contrast in every surface.
 * Region and billing-plan provider ids share the parent company's mark.
 */

import AntGroup from "@lobehub/icons/es/AntGroup/components/Mono.js";
import Anthropic from "@lobehub/icons/es/Anthropic/components/Mono.js";
import AzureAI from "@lobehub/icons/es/AzureAI/components/Mono.js";
import Baseten from "@lobehub/icons/es/Baseten/components/Mono.js";
import Bedrock from "@lobehub/icons/es/Bedrock/components/Mono.js";
import Cerebras from "@lobehub/icons/es/Cerebras/components/Mono.js";
import Claude from "@lobehub/icons/es/Claude/components/Mono.js";
import Cloudflare from "@lobehub/icons/es/Cloudflare/components/Mono.js";
import DeepSeek from "@lobehub/icons/es/DeepSeek/components/Mono.js";
import Fireworks from "@lobehub/icons/es/Fireworks/components/Mono.js";
import Gemini from "@lobehub/icons/es/Gemini/components/Mono.js";
import GithubCopilot from "@lobehub/icons/es/GithubCopilot/components/Mono.js";
import Google from "@lobehub/icons/es/Google/components/Mono.js";
import Groq from "@lobehub/icons/es/Groq/components/Mono.js";
import HuggingFace from "@lobehub/icons/es/HuggingFace/components/Mono.js";
import Kimi from "@lobehub/icons/es/Kimi/components/Mono.js";
import Minimax from "@lobehub/icons/es/Minimax/components/Mono.js";
import Mistral from "@lobehub/icons/es/Mistral/components/Mono.js";
import Moonshot from "@lobehub/icons/es/Moonshot/components/Mono.js";
import Nvidia from "@lobehub/icons/es/Nvidia/components/Mono.js";
import OpenAI from "@lobehub/icons/es/OpenAI/components/Mono.js";
import OpenCode from "@lobehub/icons/es/OpenCode/components/Mono.js";
import OpenRouter from "@lobehub/icons/es/OpenRouter/components/Mono.js";
import Pi from "@lobehub/icons/es/Pi/components/Mono.js";
import Qwen from "@lobehub/icons/es/Qwen/components/Mono.js";
import Together from "@lobehub/icons/es/Together/components/Mono.js";
import Vercel from "@lobehub/icons/es/Vercel/components/Mono.js";
import VertexAI from "@lobehub/icons/es/VertexAI/components/Mono.js";
import XAI from "@lobehub/icons/es/XAI/components/Mono.js";
import XiaomiMiMo from "@lobehub/icons/es/XiaomiMiMo/components/Mono.js";
import ZAI from "@lobehub/icons/es/ZAI/components/Mono.js";
import type { IconType } from "@lobehub/icons/es/types/index.js";

const PROVIDER_LOGOS = {
  "amazon-bedrock": Bedrock,
  "ant-ling": AntGroup,
  anthropic: Anthropic,
  "azure-openai-responses": AzureAI,
  baseten: Baseten,
  cerebras: Cerebras,
  "cloudflare-ai-gateway": Cloudflare,
  "cloudflare-workers-ai": Cloudflare,
  deepseek: DeepSeek,
  fireworks: Fireworks,
  "github-copilot": GithubCopilot,
  google: Google,
  "google-vertex": VertexAI,
  groq: Groq,
  huggingface: HuggingFace,
  "kimi-coding": Kimi,
  minimax: Minimax,
  "minimax-cn": Minimax,
  mistral: Mistral,
  moonshotai: Moonshot,
  "moonshotai-cn": Moonshot,
  nvidia: Nvidia,
  openai: OpenAI,
  "openai-codex": OpenAI,
  opencode: OpenCode,
  "opencode-go": OpenCode,
  openrouter: OpenRouter,
  "qwen-token-plan": Qwen,
  "qwen-token-plan-cn": Qwen,
  "qwen-token-plan-individual": Qwen,
  radius: Pi,
  together: Together,
  "vercel-ai-gateway": Vercel,
  xai: XAI,
  xiaomi: XiaomiMiMo,
  "xiaomi-token-plan-ams": XiaomiMiMo,
  "xiaomi-token-plan-cn": XiaomiMiMo,
  "xiaomi-token-plan-sgp": XiaomiMiMo,
  zai: ZAI,
  "zai-coding-cn": ZAI,

  // Friendly aliases may appear in custom model catalogs.
  claude: Claude,
  gemini: Gemini,
} satisfies Record<string, IconType>;

const BUILTIN_PROVIDER_IDS = [
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "azure-openai-responses",
  "baseten",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "radius",
  "together",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
] as const;

const PROVIDER_DISPLAY_NAMES: Record<(typeof BUILTIN_PROVIDER_IDS)[number], string> = {
  "amazon-bedrock": "Amazon Bedrock",
  "ant-ling": "Ant Ling",
  anthropic: "Anthropic",
  "azure-openai-responses": "Azure OpenAI",
  baseten: "Baseten",
  cerebras: "Cerebras",
  "cloudflare-ai-gateway": "Cloudflare Gateway",
  "cloudflare-workers-ai": "Workers AI",
  deepseek: "DeepSeek",
  fireworks: "Fireworks AI",
  "github-copilot": "GitHub Copilot",
  google: "Google AI",
  "google-vertex": "Vertex AI",
  groq: "Groq",
  huggingface: "Hugging Face",
  "kimi-coding": "Kimi Code",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax China",
  mistral: "Mistral AI",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI China",
  nvidia: "NVIDIA",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
  "qwen-token-plan": "Qwen Token Plan",
  "qwen-token-plan-cn": "Qwen Plan China",
  "qwen-token-plan-individual": "Qwen Individual",
  radius: "Radius",
  together: "Together AI",
  "vercel-ai-gateway": "Vercel Gateway",
  xai: "xAI",
  xiaomi: "Xiaomi",
  "xiaomi-token-plan-ams": "Xiaomi AMS",
  "xiaomi-token-plan-cn": "Xiaomi China",
  "xiaomi-token-plan-sgp": "Xiaomi Singapore",
  zai: "Z.ai",
  "zai-coding-cn": "Z.ai Coding China",
};

function providerDisplayName(provider: string): string {
  const normalized = provider.toLowerCase() as (typeof BUILTIN_PROVIDER_IDS)[number];
  const catalogName = PROVIDER_DISPLAY_NAMES[normalized];
  if (catalogName) return catalogName;
  return provider
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function hasCatalogProviderLogo(provider: string): boolean {
  return provider.toLowerCase() in PROVIDER_LOGOS;
}

/**
 * A provider mark sized by its caller (`size-3.5` in rows, `size-4` in
 * triggers). Unknown custom providers retain a deterministic monogram.
 */
function ProviderLogo({ provider, className }: { provider: string; className?: string | undefined }) {
  const Logo: IconType | undefined = PROVIDER_LOGOS[provider.toLowerCase() as keyof typeof PROVIDER_LOGOS];
  if (Logo) {
    return <Logo aria-hidden="true" className={className} focusable="false" />;
  }

  const letters = provider.replace(/[-_.]/g, " ").split(/\s+/).filter(Boolean);
  const monogram = ((letters[0]?.[0] ?? "?") + (letters[1]?.[0] ?? "")).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={`inline-flex items-center justify-center rounded-sm bg-surface-2 font-mono text-xs leading-none font-medium text-ink-2 ${className ?? ""}`}
    >
      {monogram.slice(0, 2)}
    </span>
  );
}

const ClaudeLogo = Claude;
const OpenAILogo = OpenAI;
const GeminiLogo = Gemini;

export {
  BUILTIN_PROVIDER_IDS,
  ClaudeLogo,
  GeminiLogo,
  OpenAILogo,
  ProviderLogo,
  providerDisplayName,
  hasCatalogProviderLogo,
};
