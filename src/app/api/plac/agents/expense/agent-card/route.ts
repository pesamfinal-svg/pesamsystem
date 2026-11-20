// src/app/api/plac/agents/expense/agent-card/route.ts
import { NextResponse } from 'next/server';
import { PESAM_A2A_REGISTRY } from '@/lib/agents/registry';

export async function GET() {
    const card = PESAM_A2A_REGISTRY.find(a => a.id === 'expense');
    if (!card) {
        return NextResponse.json({ error: 'Agent card not found' }, { status: 404 });
    }
    return NextResponse.json(card, {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600'
        }
    });
}
