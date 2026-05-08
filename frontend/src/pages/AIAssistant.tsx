import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bot, Send, Plus, Trash2, Loader2, Sparkles, Activity, Droplet,
  AlertTriangle, Calendar,
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { usePlants } from '@/hooks/usePlants';
import { useAppStore } from '@/store/appStore';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { DataState } from '@/components/DataState';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Msg = { role: 'user' | 'assistant'; content: string };

type Anomaly = {
  well: string;
  date: string;
  type: string;
  severity: 'low' | 'medium' | 'high' | string;
  value: number | null;
  baseline: number | null;
  message: string;
  suggested_action: string;
};

// ---------------------------------------------------------------------------
// Anthropic API helpers
// ---------------------------------------------------------------------------

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT = `You are an AI assistant for PWRI Monitoring, a multi-plant water operations management system.
You help operators, supervisors, and managers analyze water plant data including:
- Well meter readings and daily volumes
- RO train status and performance
- Locator meter readings
- Chemical usage and costs
- Downtime events and maintenance records
- NRW (Non-Revenue Water) analysis
- Anomaly detection in consumption patterns

Be concise, data-focused, and professional. When data is provided in the conversation, analyze it directly.
If asked about specific data you don't have, explain what data would be needed and how to find it in the system.`;

async function callClaude(messages: Msg[]): Promise<string> {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.content?.map((b: any) => b.text ?? '').join('') ?? '';
}

async function callClaudeForAnomalies(readings: any[]): Promise<{ anomalies: Anomaly[]; summary: string }> {
  const systemInstruction = `You are a water operations anomaly detection expert. Analyze well meter readings and identify anomalies.
Return ONLY valid JSON in this exact format, no markdown, no explanation outside the JSON:
{
  "summary": "Brief plain-text summary of findings",
  "anomalies": [
    {
      "well": "well name",
      "date": "YYYY-MM-DD",
      "type": "spike|drop|zero_reading|off_location|negative_delta",
      "severity": "low|medium|high",
      "value": 123.4,
      "baseline": 100.0,
      "message": "Short description of the anomaly",
      "suggested_action": "Recommended action"
    }
  ]
}`;

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      system: systemInstruction,
      messages: [
        {
          role: 'user',
          content: `Analyze these well meter readings for anomalies. Look for: sudden spikes or drops (>50% from baseline), zero readings, negative deltas, off-location flags.\n\nReadings:\n${JSON.stringify(readings, null, 2)}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
  }

  const data = await res.json();
  const text = data.content?.map((b: any) => b.text ?? '').join('') ?? '{}';

  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return { summary: text, anomalies: [] };
  }
}

// ---------------------------------------------------------------------------
// Local session storage (in-memory per page load)
// ---------------------------------------------------------------------------

type Session = { id: string; messages: Msg[]; preview: string; updatedAt: string };

function makeId() { return crypto.randomUUID(); }

const SUGGESTIONS = [
  'List the top 3 abnormal consumption days this month across all plants.',
  'Show wells that have been flagged defective more than 3 times.',
  'What is the average daily volume for each plant in the last 7 days?',
  'Summarize downtime for RO trains over the past 14 days.',
];

// ---------------------------------------------------------------------------

export default function AIAssistant() {
  const { user } = useAuth();
  const { data: plants } = usePlants();
  const { selectedPlantId } = useAppStore();

  const [tab, setTab] = useState<'chat' | 'anomalies'>('chat');

  // --- Chat state -----------------------------------------------------------
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const newChat = useCallback(() => {
    setActiveSessionId(null);
    setMessages([]);
    setInput('');
  }, []);

  const loadSession = useCallback((s: Session) => {
    setActiveSessionId(s.id);
    setMessages(s.messages);
  }, []);

  const deleteSession = useCallback((id: string) => {
    setSessions(prev => prev.filter(s => s.id !== id));
    if (activeSessionId === id) newChat();
    toast.success('Conversation deleted');
  }, [activeSessionId, newChat]);

  const sendMessage = useCallback(async (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg) return;
    setInput('');

    const userMsg: Msg = { role: 'user', content: msg };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setSending(true);

    try {
      const reply = await callClaude(nextMessages);
      const assistantMsg: Msg = { role: 'assistant', content: reply };
      const finalMessages = [...nextMessages, assistantMsg];
      setMessages(finalMessages);

      // Persist session in memory
      const now = new Date().toISOString();
      const preview = msg.slice(0, 60) + (msg.length > 60 ? '…' : '');

      if (activeSessionId) {
        setSessions(prev => prev.map(s =>
          s.id === activeSessionId
            ? { ...s, messages: finalMessages, preview, updatedAt: now }
            : s
        ));
      } else {
        const newId = makeId();
        const newSession: Session = { id: newId, messages: finalMessages, preview, updatedAt: now };
        setSessions(prev => [newSession, ...prev]);
        setActiveSessionId(newId);
      }
    } catch (e: any) {
      const friendly = e.message.includes('fetch') || e.message.includes('network')
        ? 'Could not reach the AI. Check your connection.'
        : e.message;
      setMessages(m => [...m, { role: 'assistant', content: `⚠ ${friendly}` }]);
      toast.error(`AI error: ${friendly}`);
    } finally {
      setSending(false);
    }
  }, [input, messages, activeSessionId]);

  // Scroll to bottom on new message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  // --- Anomaly scan state --------------------------------------------------
  const [scanPlant, setScanPlant] = useState<string>(selectedPlantId ?? '');
  const [scanWellId, setScanWellId] = useState<string>('all');
  const [scanDays, setScanDays] = useState<number>(30);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<{ anomalies: Anomaly[]; summary: string } | null>(null);

  useEffect(() => { if (selectedPlantId) setScanPlant(selectedPlantId); }, [selectedPlantId]);

  const { data: scanWells } = useQuery({
    queryKey: ['ai-wells', scanPlant],
    queryFn: async () => {
      if (!scanPlant) return [];
      const { data, error } = await supabase
        .from('wells').select('id,name').eq('plant_id', scanPlant).order('name');
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!scanPlant,
  });

  const runAnomalyScan = useCallback(async () => {
    if (!scanPlant) { toast.error('Pick a plant'); return; }
    setScanning(true);
    setScanResult(null);
    try {
      const since = new Date();
      since.setDate(since.getDate() - scanDays);

      let q = supabase.from('well_readings')
        .select('well_id,reading_datetime,previous_reading,current_reading,daily_volume,off_location_flag,wells(name)')
        .eq('plant_id', scanPlant)
        .gte('reading_datetime', since.toISOString())
        .order('reading_datetime', { ascending: true })
        .limit(1500);
      if (scanWellId !== 'all') q = q.eq('well_id', scanWellId);

      const { data, error } = await q;
      if (error) throw error;
      if (!data || data.length === 0) {
        toast.info('No readings in this window');
        setScanResult({ anomalies: [], summary: 'No readings to analyze in the selected window.' });
        return;
      }

      const readings = data.map((r: any) => ({
        well: r.wells?.name ?? r.well_id,
        date: (r.reading_datetime ?? '').slice(0, 10),
        initial: r.previous_reading,
        final: r.current_reading,
        volume: r.daily_volume,
        flags: r.off_location_flag ? ['off_location'] : [],
      }));

      const res = await callClaudeForAnomalies(readings);
      setScanResult(res);
      toast.success(`Found ${res.anomalies.length} anomaly(ies)`);
    } catch (e: any) {
      toast.error(`Scan failed: ${e.message}`);
    } finally {
      setScanning(false);
    }
  }, [scanPlant, scanWellId, scanDays]);

  const sortedAnomalies = useMemo(() => {
    const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return (scanResult?.anomalies ?? []).slice().sort(
      (a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9),
    );
  }, [scanResult]);

  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-3 animate-fade-in">
      <div className="flex items-center gap-2">
        <div className="h-8 w-8 rounded-md bg-gradient-to-br from-sky-500 to-violet-600 text-white flex items-center justify-center">
          <Sparkles className="h-4 w-4" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">AI Assistant</h1>
          <p className="text-xs text-muted-foreground">
            Ask questions about your data, or run anomaly scans on any plant.
          </p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'chat' | 'anomalies')}>
        <TabsList>
          <TabsTrigger value="chat"><Bot className="h-3.5 w-3.5 mr-1" />Chat</TabsTrigger>
          <TabsTrigger value="anomalies"><AlertTriangle className="h-3.5 w-3.5 mr-1" />Anomaly scan</TabsTrigger>
        </TabsList>

        {/* ---------------- CHAT TAB ---------------- */}
        <TabsContent value="chat" className="mt-3">
          <div className="grid gap-3 lg:grid-cols-[260px_1fr]">
            {/* Sidebar - sessions */}
            <Card className="p-2 h-[calc(100vh-260px)] min-h-[400px] flex flex-col">
              <Button size="sm" onClick={newChat} className="w-full mb-2">
                <Plus className="h-3.5 w-3.5 mr-1" /> New chat
              </Button>
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground px-1 mb-1">
                Recent
              </div>
              <div className="flex-1 overflow-auto -mx-1 space-y-1">
                <DataState
                  isEmpty={sessions.length === 0}
                  emptyTitle="No conversations yet"
                  emptyDescription="Start asking questions below."
                >
                  {sessions.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => loadSession(s)}
                      className={cn(
                        'w-full text-left px-2 py-1.5 rounded-md text-xs hover:bg-muted group flex items-start gap-1',
                        activeSessionId === s.id && 'bg-muted',
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="line-clamp-2">{s.preview || '(no messages)'}</div>
                      </div>
                      <Trash2
                        className="h-3 w-3 opacity-0 group-hover:opacity-70 hover:opacity-100 shrink-0 mt-0.5"
                        onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}
                      />
                    </button>
                  ))}
                </DataState>
              </div>
            </Card>

            {/* Main - chat thread */}
            <Card className="p-0 h-[calc(100vh-260px)] min-h-[400px] flex flex-col">
              <div className="flex-1 overflow-auto p-4 space-y-3">
                {messages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center p-6">
                    <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-2">
                      <Bot className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <h3 className="text-sm font-medium">How can I help?</h3>
                    <p className="text-xs text-muted-foreground mt-1">
                      Ask about anomalies, downtime, NRW, chemicals or wells.
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2 justify-center max-w-lg">
                      {SUGGESTIONS.map((s) => (
                        <Button key={s} size="sm" variant="outline"
                          className="text-[11px] h-auto py-1.5 whitespace-normal text-left"
                          onClick={() => sendMessage(s)}>
                          {s}
                        </Button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((m, i) => (
                    <div
                      key={i}
                      className={cn('flex gap-2', m.role === 'user' ? 'justify-end' : 'justify-start')}
                    >
                      {m.role === 'assistant' && (
                        <div className="h-7 w-7 rounded-md bg-gradient-to-br from-sky-500 to-violet-600 text-white flex items-center justify-center shrink-0 mt-0.5">
                          <Sparkles className="h-3.5 w-3.5" />
                        </div>
                      )}
                      <div className={cn(
                        'rounded-lg px-3 py-2 max-w-[80%] text-sm whitespace-pre-wrap break-words',
                        m.role === 'user'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted',
                      )}>
                        {m.content}
                      </div>
                    </div>
                  ))
                )}
                {sending && (
                  <div className="flex gap-2">
                    <div className="h-7 w-7 rounded-md bg-gradient-to-br from-sky-500 to-violet-600 text-white flex items-center justify-center shrink-0">
                      <Sparkles className="h-3.5 w-3.5" />
                    </div>
                    <div className="rounded-lg px-3 py-2 bg-muted text-sm flex items-center gap-2 text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
              <div className="border-t p-2 flex gap-2">
                <Input
                  value={input}
                  placeholder="Ask anything about your operations…"
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
                  }}
                  disabled={sending}
                  className="flex-1"
                />
                <Button onClick={() => sendMessage()} disabled={sending || !input.trim()}>
                  <Send className="h-3.5 w-3.5" />
                </Button>
              </div>
            </Card>
          </div>
        </TabsContent>

        {/* ---------------- ANOMALIES TAB ---------------- */}
        <TabsContent value="anomalies" className="mt-3">
          <Card className="p-4">
            <div className="grid gap-3 md:grid-cols-[1fr_1fr_180px_140px] items-end">
              <div>
                <Label className="text-xs">Plant</Label>
                <Select value={scanPlant} onValueChange={setScanPlant}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder="Pick plant…" /></SelectTrigger>
                  <SelectContent>
                    {(plants ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Well</Label>
                <Select value={scanWellId} onValueChange={setScanWellId} disabled={!scanPlant}>
                  <SelectTrigger className="mt-1"><SelectValue placeholder="All wells" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All wells</SelectItem>
                    {(scanWells ?? []).map((w) => (
                      <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Window (days)</Label>
                <Select value={String(scanDays)} onValueChange={(v) => setScanDays(Number(v))}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {[7, 14, 30, 60, 90].map((d) => (
                      <SelectItem key={d} value={String(d)}>{d} days</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button disabled={scanning || !scanPlant} onClick={runAnomalyScan}>
                {scanning ? <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Scanning…</>
                          : <><Activity className="h-3.5 w-3.5 mr-1" /> Run scan</>}
              </Button>
            </div>

            {scanResult && (
              <div className="mt-4 space-y-2">
                <div className="rounded-md bg-muted/50 border p-2 text-xs flex items-start gap-2">
                  <Sparkles className="h-3.5 w-3.5 mt-0.5 text-sky-600 shrink-0" />
                  <span>{scanResult.summary}</span>
                </div>
                {scanResult.anomalies.length === 0 ? (
                  <DataState isEmpty emptyTitle="No anomalies detected" emptyDescription="All clear in this window." />
                ) : (
                  <div className="border rounded-md overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr className="text-left text-[11px] text-muted-foreground">
                          <th className="px-2 py-1.5">Sev</th>
                          <th className="px-2 py-1.5">Well</th>
                          <th className="px-2 py-1.5">Date</th>
                          <th className="px-2 py-1.5">Type</th>
                          <th className="px-2 py-1.5 text-right">Value</th>
                          <th className="px-2 py-1.5 text-right">Baseline</th>
                          <th className="px-2 py-1.5">Message</th>
                          <th className="px-2 py-1.5">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedAnomalies.map((a, i) => (
                          <tr key={`${a.well}-${a.date}-${a.type}-${i}`} className="border-t">
                            <td className="px-2 py-1"><SeverityBadge sev={a.severity} /></td>
                            <td className="px-2 py-1"><span className="inline-flex items-center gap-1"><Droplet className="h-3 w-3 text-muted-foreground" />{a.well}</span></td>
                            <td className="px-2 py-1 font-mono-num"><span className="inline-flex items-center gap-1"><Calendar className="h-3 w-3 text-muted-foreground" />{a.date}</span></td>
                            <td className="px-2 py-1">{a.type}</td>
                            <td className="px-2 py-1 text-right font-mono-num">{a.value ?? '—'}</td>
                            <td className="px-2 py-1 text-right font-mono-num">{a.baseline ?? '—'}</td>
                            <td className="px-2 py-1">{a.message}</td>
                            <td className="px-2 py-1 text-muted-foreground">{a.suggested_action}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SeverityBadge({ sev }: { sev: string }) {
  const map: Record<string, string> = {
    high:   'bg-rose-100 text-rose-700 border-rose-200',
    medium: 'bg-amber-100 text-amber-700 border-amber-200',
    low:    'bg-sky-100 text-sky-700 border-sky-200',
  };
  const tone = map[sev] ?? 'bg-muted text-muted-foreground border-transparent';
  return (
    <Badge variant="outline" className={cn('font-normal capitalize', tone)}>{sev}</Badge>
  );
}
