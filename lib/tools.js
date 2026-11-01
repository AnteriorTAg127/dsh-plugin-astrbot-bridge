/**
 * Model-facing bridge tools (PRD §3.3, 分工 B5).
 *
 * These are the only path by which a DSH agent can start cross-end work. Two
 * properties are deliberate:
 *
 *   - `bridge_submit_task` returns as soon as the peer accepts, with the task
 *     id. It never waits for execution: a task may run for minutes and the model
 *     must stay responsive (§9.3, C4).
 *   - `bridge_call_astr_tool` does **not** open a tool RPC. AstrBot exposes no
 *     per-tool endpoint, so the call is expressed as a task that an A-side agent
 *     session executes (§16.4, C16). The approval rule is unchanged: a sensitive
 *     action still needs a human.
 * @module dsh-plugin-astrbot-bridge/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

/**
 * Register every bridge tool on the context.
 * @param {object} ctx - Cordis context carrying `tools`.
 * @param {object} deps - service dependencies.
 * @param {object} deps.tasks - task service.
 * @param {object} deps.sessions - session service.
 * @param {object} deps.config - normalized plugin settings.
 * @param {import('./log.js').Logger} deps.logger - structured logger.
 * @returns {() => void} disposer that unregisters every tool.
 */
export function registerBridgeTools(ctx, deps) {
  if (ctx?.tools === undefined || ctx?.tools === null) {
    throw new Error('bridge tools require ctx.tools');
  }
  const disposers = [
    ctx.tools.register(submitTaskTool(deps)),
    ctx.tools.register(taskStatusTool(deps)),
    ctx.tools.register(listSessionsTool(deps)),
    ctx.tools.register(callAstrToolTool(deps)),
  ];
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose();
    }
  };
}

/**
 * Tool: submit a task to the AstrBot side and return its id immediately.
 * @param {object} deps - service dependencies.
 * @returns {object} tool definition.
 */
export function submitTaskTool(deps) {
  return defineTool({
    name: 'bridge_submit_task',
    description:
      'Submit a task to the AstrBot bridge peer and return immediately with its task id. ' +
      'Execution happens on the peer; poll with bridge_task_status. Sensitive actions still ' +
      'require human approval on the peer side.',
    parameters: {
      text: {
        type: 'string',
        description: 'The instruction for the peer agent.',
        required: true,
      },
      purpose: {
        type: 'string',
        description: 'Optional purpose label used to select an authorized session.',
      },
      session_id: {
        type: 'string',
        description: 'Optional peer session id to target; must be authorized.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string' },
          root_task_id: { type: 'string' },
          status: { type: 'string' },
          approval_id: { type: 'string' },
          dedup: { type: 'boolean' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.status === 'pending_approval'
              ? `Task ${value.task_id} is held for human approval (approval ${value.approval_id}). Nothing was sent to the peer yet.`
              : `Submitted bridge task ${value.task_id} (status: ${value.status}). Poll bridge_task_status for progress.`,
        },
      ],
    },
    async execute(args) {
      const result = await deps.tasks.submitOutbound({
        text: args.text,
        purpose: args.purpose ?? null,
        sessionId: args.session_id ?? null,
        origin: 'llm',
        // Agent-initiated submissions are sensitive (§16.4): open a real human
        // gate before anything is sent, so the receiver can verify the eventual
        // `approval_ref` against this side's authority (§12.5/§12.7).
        requireApproval: true,
      });
      return {
        task_id: result.task_id,
        root_task_id: result.root_task_id,
        status: result.status,
        approval_id: result.approval_id,
        dedup: result.dedup === true,
      };
    },
  });
}

/**
 * Tool: read the state of one bridge task.
 * @param {object} deps - service dependencies.
 * @returns {object} tool definition.
 */
export function taskStatusTool(deps) {
  return defineTool({
    name: 'bridge_task_status',
    description: 'Read the current state of a previously submitted bridge task.',
    parameters: {
      task_id: { type: 'string', description: 'Task id returned by bridge_submit_task.', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string' },
          status: { type: 'string' },
          needs_human: { type: 'boolean' },
          summary: { type: 'string' },
          error_code: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Task ${value.task_id}: ${value.status}${value.needs_human ? ' (needs a human)' : ''}.`,
        },
      ],
    },
    async execute(args) {
      const status = await deps.tasks.status({ task_id: args.task_id });
      return {
        task_id: status.task_id,
        status: status.status,
        needs_human: status.needs_human === true,
        summary: String(status.result?.summary ?? '').slice(0, 256),
        error_code: String(status.error?.code ?? ''),
      };
    },
  });
}

/**
 * Tool: list sessions the peer authorized for this bridge.
 * @param {object} deps - service dependencies.
 * @returns {object} tool definition.
 */
export function listSessionsTool(deps) {
  return defineTool({
    name: 'bridge_list_sessions',
    description: 'List the AstrBot-side sessions this bridge is authorized to use.',
    parameters: {
      purpose: { type: 'string', description: 'Optional purpose filter.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                session_id: { type: 'string' },
                purpose: { type: 'string' },
                state: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        // The host validates the value against this schema before rendering, and
        // `execute` always returns an array, so `sessions` is present here even
        // though the declared schema marks it optional. The cast states that
        // precondition instead of adding an `?? []` fallback, which would turn a
        // contract violation into a friendly "no sessions" line.
        const listed = /** @type {{sessions: Array<{session_id: string, state: string}>}} */ (value);
        return [
          {
            type: 'text',
            text:
              listed.sessions.length === 0
                ? 'No authorized sessions.'
                : listed.sessions.map((entry) => `${entry.session_id} (${entry.state})`).join('\n'),
          },
        ];
      },
    },
    async execute(args) {
      const result = await deps.sessions.list({ purpose: args.purpose ?? null, state: 'any', limit: 50 });
      return {
        sessions: result.sessions.map((entry) => ({
          session_id: entry.session_id,
          purpose: entry.purpose ?? '',
          state: entry.state,
        })),
      };
    },
  });
}

/**
 * Tool: ask an AstrBot agent to use one of its tools.
 *
 * This is a *task*, not a tool RPC: AstrBot publishes no per-tool endpoint, so
 * the request is executed inside an authorized A-side agent session, where the
 * peer's own permission model and human approval apply (§16.4).
 * @param {object} deps - service dependencies.
 * @returns {object} tool definition.
 */
export function callAstrToolTool(deps) {
  return defineTool({
    name: 'bridge_call_astr_tool',
    description:
      'Ask an AstrBot agent session to invoke one of its own tools. This is delivered as a task ' +
      'and still passes AstrBot permission checks and human approval where required.',
    parameters: {
      tool: { type: 'string', description: 'AstrBot-side tool name.', required: true },
      args: {
        type: 'object',
        additionalProperties: true,
        description: 'Tool arguments as a JSON object.',
      },
      purpose: { type: 'string', description: 'Optional purpose label for session selection.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string' },
          status: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Requested tool through bridge task ${value.task_id} (status: ${value.status}).`,
        },
      ],
    },
    async execute(args) {
      const hints = [{ tool: args.tool, args_hint: args.args ?? {} }];
      const result = await deps.tasks.submitOutbound({
        text: `Use the tool "${args.tool}" with the provided arguments and report the result.`,
        purpose: args.purpose ?? null,
        toolHints: hints.map((hint) => hint.tool),
        origin: 'llm',
      });
      return { task_id: result.task_id, status: result.status };
    },
  });
}
