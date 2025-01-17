import OpenAI from "openai"

import { AssistantStreamEvent } from "openai/resources/beta/assistants"
import { zodToJsonSchema } from "zod-to-json-schema"
import { EventEmitter } from "node:events"
import { ZodObject, z } from "zod"

type MaybePromise<T> = T | Promise<T>

const functions: Record<string, (params: ZodObject<any>, threadId: string) => MaybePromise<any>> = {}
const tools: Record<string, OpenAI.Beta.Assistants.AssistantTool> = {}

const openai = new OpenAI();

export function registerFunction<T extends ZodObject<any>>(name: string, description: string, parameters: T, fn: (params: z.infer<T>, threadId: string) => MaybePromise<any>) {
    functions[name] = fn
    tools[name] = {
        type: "function",
        function: {
            name,
            description,
            parameters: zodToJsonSchema(parameters),
        }
    }
}

export function createAssistant(model: OpenAI.Chat.ChatModel, instructions: string) {
    return openai.beta.assistants.create({
        model,
        instructions,
        tools: Object.values(tools)
    })
}

export class EventHandler extends EventEmitter {
    constructor(public client: OpenAI) {
        super();
        this.client = client;
    }

    async onEvent(event: AssistantStreamEvent, resolve: (value: string) => void) {
        try {
            if (event.event === "thread.run.requires_action") {
                await this.handleRequiresAction(
                    event.data,
                    event.data.id,
                    event.data.thread_id,
                    resolve
                );
            } else if (event.event === "thread.run.completed") {
                const messages = await this.client.beta.threads.messages.list(event.data.thread_id)
                const answer = (messages.data ?? []).find((m) => m?.role === "assistant")?.content?.[0]

                if (answer?.type === "text") {
                    resolve(answer.text.value)
                }
            }
        } catch (error) {
            console.error("Error handling event:", error);
        }
    }

    async handleRequiresAction(data: OpenAI.Beta.Threads.Runs.Run, runId: string, threadId: string, resolve: (value: string) => void) {
        try {
            const toolOutputs = await Promise.all((data.required_action?.submit_tool_outputs.tool_calls || []).map(async (toolCall) => {
                const result = await functions[toolCall.function.name](JSON.parse(toolCall.function.arguments), threadId)

                return {
                    tool_call_id: toolCall.id,
                    output: JSON.stringify(result),
                }
            }));

            await this.submitToolOutputs(toolOutputs, runId, threadId, resolve);
        } catch (error) {
            console.error("Error processing required action:", error);
        }
    }

    async submitToolOutputs(toolOutputs: Array<OpenAI.Beta.Threads.Runs.RunSubmitToolOutputsParams.ToolOutput>, runId: string, threadId: string, resolve: (value: string) => void) {
        try {
            const stream = this.client.beta.threads.runs.submitToolOutputsStream(threadId, runId, {
                tool_outputs: toolOutputs
            });

            for await (const event of stream) {
                this.emit("event", event, resolve);
            }
        } catch (error) {
            console.error("Error submitting tool outputs:", error);
        }
    }
}