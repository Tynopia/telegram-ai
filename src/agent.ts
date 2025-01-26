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
    console.log(`Registering function: ${name}`)

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
    console.log(`Creating assistant with model: ${model}`)

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
        console.log(`Received event: ${event.event}`)

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

                console.log(`Received answer of type ${answer?.type}`)

                if (answer?.type === "text") {
                    resolve(answer.text.value)
                }
            } else if (event.event === "thread.run.failed") {
                resolve(`Der Run ist fehlgeschlagen: ${event.data.last_error?.message}`)
            }
        } catch (error) {
            console.error("Error handling event:", error);
        }
    }

    async handleRequiresAction(data: OpenAI.Beta.Threads.Runs.Run, runId: string, threadId: string, resolve: (value: string) => void) {
        console.log(`Handling required action: ${data.required_action?.type}`)

        try {
            const toolOutputs = await Promise.all((data.required_action?.submit_tool_outputs.tool_calls || []).map(async (toolCall) => {
                const args = JSON.parse(toolCall.function.arguments)

                console.log(`Processing tool call: ${toolCall.function.name}`, args)

                const result = await functions[toolCall.function.name](args, threadId)

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
        console.log(`Submitting tool outputs for run ${runId}`)

        try {
            const stream = this.client.beta.threads.runs.submitToolOutputsStream(threadId, runId, {
                tool_outputs: toolOutputs
            });

            console.log(`Submitted tool outputs for run ${runId}`)

            for await (const event of stream) {
                this.emit("event", event, resolve);
            }
        } catch (error) {
            console.error("Error submitting tool outputs:", error);
        }
    }
}