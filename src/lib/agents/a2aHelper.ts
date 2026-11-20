// src/lib/agents/a2aHelper.ts
// Pomocnik protokołu Google Agent-to-Agent (A2A)

import {
    Task,
    TaskState,
    A2A_PROTOCOL_VERSION,
    A2A_VERSION_HEADER
} from '@a2a-js/sdk';

export interface A2ATaskResult {
    taskId: string;
    state: 'COMPLETED' | 'INPUT_REQUIRED' | 'FAILED';
    speechReply: string;
    data?: any;
    missingFields?: string[];
    quickReplies?: string[];
}

/**
 * Buduje znormalizowany obiekt A2A Task zgodnie ze specyfikacją @a2a-js/sdk
 */
export function buildA2ATaskResponse(params: {
    taskId: string;
    contextId?: string;
    state: TaskState;
    messageText: string;
    data?: any;
    metadata?: Record<string, any>;
}): Task {
    const rawDataJson = params.data ? JSON.stringify(params.data) : '';

    return Task.fromJSON({
        id: params.taskId,
        contextId: params.contextId || `ctx_${Date.now()}`,
        status: {
            state: params.state,
            message: {
                role: 'ROLE_AGENT',
                parts: [
                    {
                        content: {
                            $case: 'text',
                            value: params.messageText
                        }
                    }
                ]
            }
        },
        artifacts: rawDataJson ? [
            {
                name: 'result-data',
                parts: [
                    {
                        content: {
                            $case: 'text',
                            value: rawDataJson
                        }
                    }
                ]
            }
        ] : [],
        metadata: {
            speechReply: params.messageText,
            ...(params.metadata || {})
        }
    });
}

/**
 * Klient A2A wywołujący agenta przez HTTP POST z nagłówkami A2A
 */
export async function dispatchA2ATask(
    agentEndpoint: string,
    payload: {
        userMessage: string;
        userContext?: {
            userId?: string;
            userName?: string;
            userEmail?: string;
        };
        sessionContext?: Record<string, any>;
    },
    baseUrl?: string
): Promise<A2ATaskResult> {
    const fullUrl = agentEndpoint.startsWith('http')
        ? agentEndpoint
        : `${baseUrl || 'http://localhost:3000'}${agentEndpoint}`;

    const res = await fetch(fullUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            [A2A_VERSION_HEADER]: A2A_PROTOCOL_VERSION
        },
        body: JSON.stringify({
            message: {
                role: 'ROLE_USER',
                parts: [{ text: payload.userMessage }]
            },
            context: {
                user: payload.userContext,
                session: payload.sessionContext
            }
        })
    });

    if (!res.ok) {
        throw new Error(`A2A Agent [${agentEndpoint}] HTTP Error ${res.status}: ${res.statusText}`);
    }

    const taskJson = await res.json();
    const task = Task.fromJSON(taskJson);

    // Wyciągnij tekst odpowiedzi ze statusu lub metadanych
    const speechReply = (task.metadata as any)?.speechReply ||
        (task.status?.message?.parts?.[0]?.content as any)?.value ||
        'Zadanie zostało przetworzone.';

    // Wyciągnij dane z artefaktów
    let data: any = null;
    const dataArtifact = task.artifacts?.find(a => a.name === 'result-data');
    if (dataArtifact?.parts?.[0]?.content) {
        try {
            const raw = (dataArtifact.parts[0].content as any).value;
            data = JSON.parse(raw);
        } catch {
            data = null;
        }
    }

    const rawState = task.status?.state;
    let stateStr: 'COMPLETED' | 'INPUT_REQUIRED' | 'FAILED' = 'COMPLETED';
    if (rawState === TaskState.TASK_STATE_INPUT_REQUIRED) {
        stateStr = 'INPUT_REQUIRED';
    } else if (rawState === TaskState.TASK_STATE_FAILED) {
        stateStr = 'FAILED';
    }

    return {
        taskId: task.id || `task_${Date.now()}`,
        state: stateStr,
        speechReply,
        data,
        missingFields: (task.metadata as any)?.missingFields || [],
        quickReplies: (task.metadata as any)?.quickReplies || []
    };
}
