import "dotenv/config"
import "./bing"

import TelegramBot from "node-telegram-bot-api";
import Database from "better-sqlite3";
import OpenAI from "openai";

import { createAssistant, EventHandler, registerFunction } from "./agent";
import { Assistant } from "openai/resources/beta/assistants";
import { CronJob } from "cron";
import { z } from "zod";

interface Tenant {
    number: string
    system: string
    timezone: string
}

interface Job {
    id: number
    tenant: string
    hour: number
    minute: number
    prompt: string
}

interface Metadata {
    tenant: string
}

if (!process.env.TELEGRAM) {
    throw new Error("Telegram environment variable is required")
}

const db = new Database("database.db", { verbose: console.log });
const telegramBot = new TelegramBot(process.env.TELEGRAM, { polling: true });

const assistants: Record<string, Assistant> = {}
const cronJobs: Record<number, CronJob> = {}
const threads: Record<string, string> = {}

const client = new OpenAI();

for (const job of db.prepare<Job[], Job>("SELECT * FROM jobs").all()) {
    createPrompt(job)
}

registerFunction("model_infos", "Retrieves general informations about this AI Model like Author, Version, etc.", z.object({}), function () {
    return {
        author: "Lukas Leisten / Jendrik Wendt",
        version: "0.0.1",
    }
})

registerFunction("timestamp", "Retrieves the current timestamp.", z.object({}), function () {
    return new Date().toISOString()
})

registerFunction(
    "retrieve_tenant",
    "Retrieve the tenant information of the user. This is useful for when the user wants to see or manage their tenant information.",
    z.object({}),
    async function (_, threadId) {
        const thread = await client.beta.threads.retrieve(threadId)
        const metadata = thread.metadata as Metadata

        return db.prepare<string, Tenant>("SELECT * FROM tenants WHERE number = ?").get(metadata.tenant)
    }
)

registerFunction(
    "retrieve_prompts",
    "Retrieve all saved prompts of the user that are scheduled to be sent at a specific time. This is useful for when the user wants to see or manage their saved prompts.",
    z.object({}),
    async function (_, threadId) {
        const thread = await client.beta.threads.retrieve(threadId)
        const metadata = thread.metadata as Metadata

        return db.prepare("SELECT id, prompt, hour, minute FROM jobs WHERE tenant = ?").all(metadata.tenant)
    }
)

registerFunction(
    "create_prompt",
    "Creates a new prompt for the user. This is useful for when the user wants to save a new prompt for a specific time.",
    z.object({
        prompt: z.string().describe("the prompt to save"),
        hour: z.number().int().min(0).max(23).describe("the hour at which the prompt should be triggered"),
        minute: z.number().int().min(0).max(59).describe("the minute at which the prompt should be triggered").default(0)
    }),
    async function (args, threadId) {
        const thread = await client.beta.threads.retrieve(threadId)
        const metadata = thread.metadata as Metadata

        const result = db.prepare("INSERT INTO jobs (tenant, hour, minute, prompt) VALUES (?, ?, ?, ?)").run(metadata.tenant, args.hour, args.minute, args.prompt)

        if (result.changes > 0) {
            const lastJob = db.prepare<string, Job>("SELECT * FROM jobs WHERE tenant = ? ORDER BY id DESC LIMIT 1").get(metadata.tenant)
            createPrompt(lastJob)
        }

        return result
    }
)

registerFunction(
    "edit_prompt",
    "Edits the users saved prompt. This is useful for when the user wants to change their prompt for a specific time.",
    z.object({
        prompt: z.string().describe("the new prompt to save").optional(),
        hour: z.number().int().min(0).max(23).describe("the new hour at which the prompt should be triggered").optional(),
        minute: z.number().int().min(0).max(59).describe("the new minute at which the prompt should be triggered").optional(),
        id: z.number().int().describe("the id of the prompt to edit"),
    }),
    async function (args, threadId) {
        const thread = await client.beta.threads.retrieve(threadId)
        const metadata = thread.metadata as Metadata

        const result = db.prepare("UPDATE jobs SET prompt = COALESCE(?, prompt), hour = COALESCE(?, hour), minute = COALESCE(?, minute) WHERE tenant = ? AND id = ?").run(args.prompt, args.hour, args.minute, metadata.tenant, args.id)

        if (result.changes > 0) {
            const job = db.prepare<number, Job>("SELECT * FROM jobs WHERE id = ?").get(args.id)
            createPrompt(job)
        }

        return result
    }
)

registerFunction(
    "delete_prompt",
    "Deletes the users saved prompt. This is useful for when the user wants to remove a prompt for a specific time.",
    z.object({
        id: z.number().int().describe("the id of the prompt to delete")
    }),
    async function (args, threadId) {
        const thread = await client.beta.threads.retrieve(threadId)
        const metadata = thread.metadata as Metadata

        const result = db.prepare("DELETE FROM jobs WHERE tenant = ? AND id = ?").run(metadata.tenant, args.id)

        if (result.changes > 0 && cronJobs[args.id]) {
            cronJobs[args.id].stop()
            delete cronJobs[args.id]
        }

        return result
    }
)

registerFunction(
    "edit_tenant",
    "Edits the users tenant information. This is useful for when the user wants to change their tenant information.",
    z.object({
        system: z.string().describe("the new system prompt to save").optional(),
        timezone: z.string().describe("the new timezone to save in the IANA timezone database format").optional(),
    }),
    async function (args, threadId) {
        const thread = await client.beta.threads.retrieve(threadId)
        const metadata = thread.metadata as Metadata

        const result = db.prepare("UPDATE tenants SET system = COALESCE(?, system), timezone = COALESCE(?, timezone) WHERE number = ?").run(args.system, args.timezone, metadata.tenant)

        if (result.changes > 0) {
            const system = db.prepare<string, string>("SELECT system FROM tenants WHERE number = ?").pluck().get(metadata.tenant)
            client.beta.assistants.update(assistants[metadata.tenant].id, {
                instructions: system
            })
        }

        return result
    }
)

async function getAssistant(tenant: string) {
    const system = db.prepare<string, string>("SELECT system FROM tenants WHERE number = ?").pluck().get(tenant)

    if (!system) {
        throw new Error("Tenant not found")
    }

    if (!assistants[tenant]) {
        const assistant = await createAssistant("gpt-4o", system);
        assistants[tenant] = assistant;
    }

    return assistants[tenant]
}

async function createThread(tenant: string) {
    return client.beta.threads.create({
        metadata: {
            tenant
        }
    });
}

async function getThread(tenant: string) {
    if (!threads[tenant]) {
        const thread = await createThread(tenant)
        threads[tenant] = thread.id
    }

    return threads[tenant]
}

async function createMessage(tenant: string, threadId: string, content: string) {
    const assistant = await getAssistant(tenant);

    await client.beta.threads.messages.create(threadId, {
        role: "user",
        content
    });

    const eventHandler = new EventHandler(client);
    eventHandler.on("event", eventHandler.onEvent.bind(eventHandler));

    const stream = client.beta.threads.runs.stream(
        threadId,
        { assistant_id: assistant.id }
    );

    const promise = new Promise<string>(async function (resolve) {
        for await (const event of stream) {
            eventHandler.emit("event", event, resolve);
        }
    })

    return promise
}

function createPrompt(job?: Job) {
    if (!job) return

    if (cronJobs[job.id]) {
        cronJobs[job.id].stop()
    }

    const timeZone = db.prepare<string, string>("SELECT timezone FROM tenants WHERE number = ?").pluck().get(job.tenant)

    const cronJob = new CronJob(`${job.minute} ${job.hour} * * *`, async function () {
        const thread = await createThread(job.tenant)
        const result = await createMessage(job.tenant, thread.id, job.prompt)

        telegramBot.sendMessage(job.tenant, result);
    }, null, true, timeZone);

    cronJobs[job.id] = cronJob
}

telegramBot.on("message", async function (message) {
    if (!message.text) {
        return
    }

    const chatId = message.chat.id;

    const interval = setInterval(function () {
        telegramBot.sendChatAction(chatId, "typing");
    }, 5000);

    const thread = await getThread(chatId.toString())
    const result = await createMessage(chatId.toString(), thread, message.text)

    clearInterval(interval);

    telegramBot.sendMessage(chatId, result, {
        parse_mode: "Markdown"
    });
});