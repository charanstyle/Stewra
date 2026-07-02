import { execFile, execFileSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { IModelClient, ModelMessage } from '@stewra/shared-types';
import { config } from '../config/unifiedConfig';
import { chooseModelProvider } from './modelProvider';

/** A short advisory insight never needs many tokens; bound the API call. */
const MAX_OUTPUT_TOKENS = 1024;

/** Split a message list into the Anthropic-style (system text, user/assistant turns). */
function splitMessages(messages: ReadonlyArray<ModelMessage>): {
  system: string;
  turns: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const turns = messages
    .filter((m): m is ModelMessage & { role: 'user' | 'assistant' } => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
  return { system, turns };
}

/**
 * The default model client: shells out to the locally installed `claude` CLI in print mode
 * (`claude -p`), so the agent loop runs on the user's existing Claude Code subscription with NO API
 * key. The prompt is passed on stdin (never the shell) via `execFile`, so derived-fact strings can't
 * be interpreted as shell — the same untrusted-input discipline the broker enforces. This lives in
 * the control-plane host, never in the agent-runtime package, so the agent gains no process access.
 */
export class ClaudeCliModelClient implements IModelClient {
  private readonly binary: string;
  private readonly modelId: string;

  constructor(binary: string, modelId: string) {
    this.binary = binary;
    this.modelId = modelId;
  }

  async complete(messages: ReadonlyArray<ModelMessage>): Promise<string> {
    const { system, turns } = splitMessages(messages);
    const prompt = turns.map((t) => t.content).join('\n\n');

    const args = ['-p', '--output-format', 'text'];
    if (this.modelId.length > 0) {
      args.push('--model', this.modelId);
    }
    if (system.length > 0) {
      args.push('--append-system-prompt', system);
    }

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        this.binary,
        args,
        { maxBuffer: 1024 * 1024 },
        (error, out) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(out);
        },
      );
      child.stdin?.end(prompt);
    });

    return stdout.trim();
  }
}

/**
 * Alternative model client for servers without the Claude CLI: a thin Anthropic-SDK adapter behind
 * the same interface, selected only when MODEL_PROVIDER='anthropic_api'. System messages lift into
 * the Anthropic `system` field; user/assistant turns become `messages`.
 */
export class AnthropicModelClient implements IModelClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async complete(messages: ReadonlyArray<ModelMessage>): Promise<string> {
    const { system, turns } = splitMessages(messages);
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      ...(system.length > 0 ? { system } : {}),
      messages: turns.map((t) => ({ role: t.role, content: t.content })),
    });
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  }
}

/**
 * Adapter for any OpenAI-compatible Chat Completions API — covers OpenAI, xAI (Grok), and Google
 * (Gemini's OpenAI-compatible endpoint). One implementation, parameterized by base URL + key + model
 * (all from config), so adding an OpenAI-compatible vendor is just a base-URL mapping.
 */
export class OpenAICompatibleModelClient implements IModelClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(apiKey: string, baseUrl: string, model: string) {
    this.client = new OpenAI({ apiKey, baseURL: baseUrl });
    this.model = model;
  }

  async complete(messages: ReadonlyArray<ModelMessage>): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    return (response.choices[0]?.message?.content ?? '').trim();
  }
}

/**
 * A deterministic, offline model client kept for tests and local runs without a model. It is NOT
 * wired by default but lets the agent loop be exercised without any external call.
 */
export class LocalDeterministicModelClient implements IModelClient {
  async complete(messages: ReadonlyArray<ModelMessage>): Promise<string> {
    const userMessage = [...messages].reverse().find((m) => m.role === 'user');
    if (userMessage === undefined) {
      return 'No context was provided, so there is nothing to advise on.';
    }
    const factLines = userMessage.content
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
      .filter((line) => line.length > 0);

    if (factLines.length === 0) {
      return 'Nothing stands out right now — you look clear.';
    }
    return `Worth noting: ${factLines.join('; ')}.`;
  }
}

/**
 * Is the local `claude` CLI actually RUNNABLE on this host? Not just present on PATH — we run
 * `claude --version` (fast, no auth, no token cost) and treat any failure (missing binary, non-zero
 * exit, hang past the timeout) as "unavailable". Probed ONCE at host build time; the result decides
 * the provider for the process lifetime. Kept separate + injectable so `chooseModelProvider` stays a
 * pure, unit-testable decision.
 */
export function isClaudeCliAvailable(binary: string): boolean {
  try {
    execFileSync(binary, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function buildModelClient(): IModelClient {
  const { provider, preferClaudeCli, claudeCodePath, modelId, apiKey, baseUrl } = config.model;
  const effective = chooseModelProvider({
    preferClaudeCli,
    cliAvailable: isClaudeCliAvailable(claudeCodePath),
    fallbackProvider: provider,
  });
  switch (effective) {
    case 'anthropic':
      return new AnthropicModelClient(apiKey, modelId);
    case 'openai':
    case 'gemini':
    case 'grok':
      return new OpenAICompatibleModelClient(apiKey, baseUrl, modelId);
    case 'claude_cli':
    default:
      return new ClaudeCliModelClient(claudeCodePath, modelId);
  }
}

export const modelClient: IModelClient = buildModelClient();
