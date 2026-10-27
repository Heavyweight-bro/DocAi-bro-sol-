import React, { useEffect, useState } from 'react';
import { AlertCircle, Loader2, RotateCcw } from 'lucide-react';

type Stats = {
  period: { days: number; since: string };
  totals: { documentsProcessed: number; failed: number; retries: number; escalated: number; manualEdits: number; costUsd: number; costPerDocumentUsd: number; promptTokens: number; completionTokens: number };
  quality: { reviewed: number; approvedWithoutEdits: number; firstPassAccuracy: number | null; editedDocuments: number; pendingReview: number; invalid: number };
  byDay: { day: string; documents: number; costUsd: number; failed: number }[];
  byModel: { model: string; runs: number; costUsd: number; promptTokens: number; completionTokens: number; avgDurationMs: number; priced: boolean }[];
  byTemplate: { typeSlug: string; documents: number; approved: number; edited: number; invalid: number }[];
  byActor: { actor: string; documents: number }[];
};

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : n > 0 ? `$${n.toFixed(5)}` : '$0');
const int = (n: number) => n.toLocaleString('uk-UA');
const pct = (n: number | null) => (n == null ? '—' : `${Math.round(n * 100)}%`);
const dayLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });

/** Clean axis maximum: 1, 2, 5 × 10^k at or above the data maximum. */
function niceMax(max: number) {
  if (max <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  return ([1, 2, 5, 10].find((m) => m * exp >= max) || 10) * exp;
}

/** Single-series column chart: one hue, baseline-anchored rounded ends, per-column hover tooltip. */
function ColumnChart({ data, value, format, title, subtitle, integer }: {
  data: Stats['byDay']; value: (d: Stats['byDay'][number]) => number; format: (n: number) => string; title: string; subtitle: string; integer?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const raw = niceMax(Math.max(...data.map(value), 0));
  // Counts need whole-number ticks: keep the maximum even so the midpoint is an integer too.
  const max = integer ? Math.max(2, Math.ceil(raw / 2) * 2) : raw;
  const ticks = [0, max / 2, max];
  const labelEvery = Math.ceil(data.length / 8);
  return (
    <figure className="chart-card">
      <figcaption><strong>{title}</strong><span>{subtitle}</span></figcaption>
      <div className="column-chart" onMouseLeave={() => setHover(null)}>
        <div className="y-axis">{[...ticks].reverse().map((t) => <span key={t}>{format(t)}</span>)}</div>
        <div className="plot">
          {ticks.map((t) => <i key={t} className="gridline" style={{ bottom: `${(t / max) * 100}%` }} />)}
          <div className="columns" style={{ gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }}>
            {data.map((d, i) => {
              const v = value(d);
              return (
                <button
                  key={d.day}
                  type="button"
                  className="column-slot"
                  aria-label={`${dayLabel(d.day)}: ${format(v)}`}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                >
                  <span className="column" style={{ height: v > 0 ? `max(2px, ${(v / max) * 100}%)` : 0 }} />
                  {hover === i && (
                    <span className={`chart-tip ${i > data.length * 0.7 ? 'left' : ''}`} role="tooltip">
                      <b>{dayLabel(d.day)}</b>{format(v)}{d.failed ? <em>помилок: {d.failed}</em> : null}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <div className="x-axis" style={{ gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))` }}>
          {data.map((d, i) => <span key={d.day}>{i % labelEvery === 0 ? dayLabel(d.day) : ''}</span>)}
        </div>
      </div>
    </figure>
  );
}

export default function Analytics() {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch(`/api/v1/stats?days=${days}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Не вдалося завантажити статистику');
      setStats(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Помилка');
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [days]);

  const t = stats?.totals;
  const q = stats?.quality;
  const unpriced = stats?.byModel.filter((m) => !m.priced).map((m) => m.model) || [];

  return (
    <div className="analytics-page">
      <div className="page-heading">
        <div><div className="eyebrow">АНАЛІТИКА</div><h2>Витрати та якість</h2><p>Скільки коштує обробка і як часто AI помиляється — за журналом аудиту.</p></div>
        <div className="filter-row" role="group" aria-label="Період">
          {[7, 30, 90].map((d) => <button key={d} className={days === d ? 'active' : ''} aria-pressed={days === d} onClick={() => setDays(d)}>{d} днів</button>)}
          <button onClick={load} aria-label="Оновити" title="Оновити"><RotateCcw size={14} /></button>
        </div>
      </div>
      {error && <div className="error-banner"><AlertCircle size={16} /><span>{error}</span></div>}
      {!stats && loading && <div className="p-8 text-center"><Loader2 className="animate-spin inline" /></div>}
      {stats && t && q && (
        <>
          <div className="kpi-grid">
            <div className="kpi"><small>Оброблено</small><strong>{int(t.documentsProcessed)}</strong><span>{t.failed ? `з них помилок: ${t.failed}` : 'без помилок AI'}</span></div>
            <div className="kpi"><small>Витрати AI (оцінка)</small><strong>{usd(t.costUsd)}</strong><span>{usd(t.costPerDocumentUsd)} за документ</span></div>
            <div className="kpi"><small>Правильно з першого разу</small><strong>{pct(q.firstPassAccuracy)}</strong><span>{q.reviewed ? `${q.approvedWithoutEdits} з ${q.reviewed} перевірених` : 'ще немає перевірених'}</span></div>
            <div className="kpi"><small>Чекають перевірки</small><strong>{int(q.pendingReview)}</strong><span>{q.invalid ? `ще ${q.invalid} зі схемою, що не пройдена` : 'схема: без проблем'}</span></div>
            <div className="kpi"><small>Ескалація моделі</small><strong>{int(t.escalated)}</strong><span>повторів AI: {t.retries}</span></div>
            <div className="kpi"><small>Токени</small><strong>{int(t.promptTokens + t.completionTokens)}</strong><span>вхід {int(t.promptTokens)} · вихід {int(t.completionTokens)}</span></div>
          </div>
          {unpriced.length > 0 && <p className="role-note">Для {unpriced.join(', ')} ціна невідома — витрати оцінено за середнім тарифом провайдера. Задайте точні ціни в DOCAI_MODEL_PRICES.</p>}

          <div className="chart-grid">
            <ColumnChart data={stats.byDay} value={(d) => d.documents} format={(n) => int(Math.round(n))} integer title="Документи за днями" subtitle="Завершені обробки, включно з помилками" />
            <ColumnChart data={stats.byDay} value={(d) => d.costUsd} format={usd} title="Витрати за днями" subtitle="Оцінка за тарифами моделей, USD" />
          </div>

          <div className="chart-grid">
            <section className="corporate-panel">
              <h3 className="panel-h">Моделі</h3>
              <table className="data-table">
                <thead><tr><th>Модель</th><th>Запусків</th><th>Витрати</th><th>Сер. час</th></tr></thead>
                <tbody>
                  {stats.byModel.map((m) => <tr key={m.model}><td>{m.model}{!m.priced && <em title="Ціна невідома"> *</em>}</td><td>{int(m.runs)}</td><td>{usd(m.costUsd)}</td><td>{m.avgDurationMs >= 100 ? `${(m.avgDurationMs / 1000).toFixed(1)} с` : m.avgDurationMs ? '< 0.1 с' : '—'}</td></tr>)}
                  {!stats.byModel.length && <tr><td colSpan={4}>Даних за період немає</td></tr>}
                </tbody>
              </table>
            </section>
            <section className="corporate-panel">
              <h3 className="panel-h">Шаблони</h3>
              <table className="data-table">
                <thead><tr><th>Шаблон</th><th>Документів</th><th>Підтверджено</th><th>Виправлено</th><th>Схема не пройдена</th></tr></thead>
                <tbody>
                  {stats.byTemplate.map((r) => <tr key={r.typeSlug}><td>{r.typeSlug}</td><td>{int(r.documents)}</td><td>{int(r.approved)}</td><td>{int(r.edited)}</td><td>{int(r.invalid)}</td></tr>)}
                  {!stats.byTemplate.length && <tr><td colSpan={5}>Даних за період немає</td></tr>}
                </tbody>
              </table>
            </section>
          </div>

          <details className="corporate-panel table-view">
            <summary>Таблиця за днями</summary>
            <table className="data-table">
              <thead><tr><th>День</th><th>Документи</th><th>Помилки</th><th>Витрати</th></tr></thead>
              <tbody>{[...stats.byDay].reverse().map((d) => <tr key={d.day}><td>{dayLabel(d.day)}</td><td>{d.documents}</td><td>{d.failed}</td><td>{usd(d.costUsd)}</td></tr>)}</tbody>
            </table>
          </details>
        </>
      )}
    </div>
  );
}
