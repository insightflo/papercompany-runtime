#!/usr/bin/env python3
# scripts/agent-wiki-dashboard.py
#
# [목적] agent 자가학습 wiki 축적 내역(entries) + 최근 실패 발생 추이(timeseries)를
#   self-contained HTML 대시보드로 생성해 ~/Downloads 에 저장 후 연다. UI 페이지와 별개로,
#   DB를 직접 조회해 매 실행마다 최신 스냅샷을 보여준다 (재실행 = 갱신).
# [입력] argv[1]=companyId (기본 gazua 회사), argv[2]=days (기본 14)
# [외부 연결] psql (로컬 54330). API(/api/companies/:id/agent-wiki)와 동일 데이터.
# [수정시 주의] 차트/테이블 컬럼을 바꾸면 쿼리 select 절과 JS 렌더도 함께.

import json
import os
import subprocess
import sys
import datetime
import html

PSQL = "/opt/homebrew/opt/libpq/bin/psql"
DEFAULT_COMPANY = "9045933e-40ca-4a08-8dad-38a8a054bdf3"  # gazua 회사
OUT = os.path.expanduser("~/Downloads/agent-wiki-dashboard.html")


def run_psql(sql: str) -> str:
    env = {**os.environ, "PGPASSWORD": "paperclip"}
    r = subprocess.run(
        [PSQL, "-h", "127.0.0.1", "-p", "54330", "-U", "paperclip", "-d", "paperclip", "-t", "-A", "-c", sql],
        capture_output=True, text=True, env=env,
    )
    if r.returncode != 0:
        sys.stderr.write(r.stderr)
        sys.exit(1)
    return r.stdout.strip()


def fetch(company_id: str, days: int):
    entries_sql = (
        "SELECT coalesce(json_agg(row_to_json(t)), '[]') FROM ("
        " SELECT pattern, error_code, frequency, status, agent_id, cause, solution, "
        " to_char(created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') created_kst, "
        " to_char(last_seen_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') last_seen_kst "
        f" FROM agent_wiki_entries WHERE company_id='{company_id}' ORDER BY frequency DESC, updated_at DESC"
        ") t;"
    )
    ts_sql = (
        "SELECT coalesce(json_agg(row_to_json(t)), '[]') FROM ("
        " SELECT to_char(finished_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD') AS \"day\", "
        " error_code, count(*)::int AS \"count\" FROM heartbeat_runs "
        f" WHERE company_id='{company_id}' AND finished_at >= now()-interval '{days} days' "
        " AND status<>'succeeded' GROUP BY 1,2 ORDER BY 1"
        ") t;"
    )
    entries = json.loads(run_psql(entries_sql) or "[]")
    timeseries = json.loads(run_psql(ts_sql) or "[]")
    return entries, timeseries


HTML_TEMPLATE = """<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Wiki 대시보드</title>
<style>
  :root { --bg:#0d1117; --card:#161b22; --border:#30363d; --txt:#c9d1d9; --mut:#8b949e; --accent:#58a6ff; --red:#f85149; --green:#3fb950; --yellow:#d29922; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--txt); font:14px/1.5 -apple-system,BlinkMacSystemFont,'Pretendard',sans-serif; padding:24px; }
  h1 { font-size:20px; margin:0 0 4px; } .sub { color:var(--mut); margin:0 0 20px; font-size:13px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:24px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px; }
  .card .n { font-size:28px; font-weight:700; color:var(--accent); } .card .l { color:var(--mut); font-size:12px; margin-top:4px; }
  section { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:18px; margin-bottom:20px; }
  h2 { font-size:15px; margin:0 0 14px; color:#fff; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--border); vertical-align:top; }
  th { color:var(--mut); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.03em; }
  td.cause,td.solution { max-width:320px; color:var(--mut); font-size:12px; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; }
  .pill.active { background:rgba(248,81,73,.15); color:var(--red); } .pill.resolved { background:rgba(63,185,80,.15); color:var(--green); } .pill.closed { background:rgba(139,148,159,.15); color:var(--mut); }
  .freq { font-weight:700; color:var(--yellow); }
  #chart { width:100%; height:240px; } .legend { display:flex; flex-wrap:wrap; gap:10px; margin-top:10px; font-size:12px; }
  .legend span { display:inline-flex; align-items:center; gap:5px; } .legend i { width:10px; height:10px; border-radius:2px; display:inline-block; }
  .empty { color:var(--mut); padding:20px 0; text-align:center; }
  code { background:#21262d; padding:1px 5px; border-radius:4px; font-size:12px; }
</style></head><body>
<h1>🧠 Agent 자가학습 Wiki 대시보드</h1>
<p class="sub">축적된 실패 교훈 + 최근 실패 발생 추이 · 생성: <span id="gen"></span></p>
<div class="cards" id="cards"></div>
<section><h2>📚 축적된 교훈 (entries)</h2><div id="entries"></div></section>
<section><h2>📈 최근 실패 발생 추이 (일자별)</h2><svg id="chart"></svg><div class="legend" id="legend"></div></section>
<script>
const DATA = __DATA__;
const COLORS = ['#f85149','#58a6ff','#d29922','#3fb950','#bc8cff','#ff7b72','#79c0ff','#e3b341'];
document.getElementById('gen').textContent = DATA.gen + ' (재실행 시 갱신)';
// summary cards
const total = DATA.entries.length;
const active = DATA.entries.filter(e=>e.status==='active').length;
const resolved = DATA.entries.filter(e=>e.status==='resolved').length;
const hits = DATA.entries.reduce((s,e)=>s+(e.frequency||0),0);
document.getElementById('cards').innerHTML = [
  ['교훈 entry 수', total], ['활성(active)', active], ['해결(resolved)', resolved], ['누적 발생(frequency 합)', hits]
].map(([l,n])=>`<div class="card"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
// entries table
const ent = DATA.entries;
if(!ent.length){ document.getElementById('entries').innerHTML='<div class="empty">아직 축적된 교훈이 없습니다.</div>'; }
else {
  document.getElementById('entries').innerHTML = '<table><thead><tr><th>패턴</th><th>에러코드</th><th>발생</th><th>상태</th><th>최근(KST)</th><th>원인</th><th>해결가이드(주입 교훈)</th></tr></thead><tbody>'
    + ent.map(e=>`<tr><td><b>${esc(e.pattern)}</b><br><span style="color:var(--mut);font-size:11px">${shortId(e.agent_id)}</span></td>
    <td><code>${esc(e.error_code||'-')}</code></td><td class="freq">${e.frequency}회</td>
    <td><span class="pill ${e.status}">${e.status}</span></td><td>${esc(e.last_seen_kst||'-')}</td>
    <td class="cause">${esc(e.cause)}</td><td class="solution">${esc(e.solution)}</td></tr>`).join('') + '</tbody></table>';
}
// chart: stacked bars by day, colored by errorCode
const ts = DATA.timeseries;
const codes = [...new Set(ts.map(p=>p.error_code||'(none)'))];
const codeColor = {}; codes.forEach((c,i)=>codeColor[c]=COLORS[i%COLORS.length]);
const days = [...new Set(ts.map(p=>p.day))].sort();
const byDay = {}; days.forEach(d=>byDay[d]={}); ts.forEach(p=>{ byDay[p.day][p.error_code||'(none)']=(byDay[p.day][p.error_code||'(none)']||0)+p.count; });
const maxV = Math.max(1, ...days.map(d=>Object.values(byDay[d]).reduce((a,b)=>a+b,0)));
if(!days.length){ document.getElementById('chart').replaceWith(Object.assign(document.createElement('div'),{className:'empty',textContent:'최근 실패 기록이 없습니다.'})); }
else {
  const W=900,H=240,PL=36,PR=12,PT=12,PB=28, BW=Math.max(8,(W-PL-PR)/days.length-6);
  let s=`<text x="${PL}" y="${PT-2}" fill="#8b949e" font-size="11">${maxV} ← max</text>`;
  days.forEach((d,i)=>{
    const x=PL+i*((W-PL-PR)/days.length);
    let y=H-PB, segs='';
    codes.forEach(c=>{ const v=byDay[d][c]||0; if(!v)return; const h=(v/maxV)*(H-PT-PB); segs+=`<rect x="${x}" y="${y-h}" width="${BW}" height="${h}" fill="${codeColor[c]}"><title>${d} ${c}: ${v}</title></rect>`; y-=h; });
    s+=segs;
    if(i%Math.ceil(days.length/8)===0||i===days.length-1){ s+=`<text x="${x}" y="${H-PB+14}" fill="#8b949e" font-size="10">${d.slice(5)}</text>`; }
  });
  s+=`<line x1="${PL}" y1="${H-PB}" x2="${W-PR}" y2="${H-PB}" stroke="#30363d"/>`;
  document.getElementById('chart').setAttribute('viewBox',`0 0 ${W} ${H}`); document.getElementById('chart').setAttribute('preserveAspectRatio','xMidYMid meet');
  document.getElementById('chart').innerHTML=s;
  document.getElementById('legend').innerHTML = codes.map(c=>`<span><i style="background:${codeColor[c]}"></i>${esc(c)}</span>`).join('');
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function shortId(u){ return u?String(u).slice(0,8):''; }
</script></body></html>
"""


def main():
    company_id = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_COMPANY
    days = int(sys.argv[2]) if len(sys.argv) > 2 else 14
    entries, timeseries = fetch(company_id, days)
    payload = {
        "entries": entries,
        "timeseries": timeseries,
        "days": days,
        "gen": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    doc = HTML_TEMPLATE.replace("__DATA__", json.dumps(payload, ensure_ascii=False))
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(doc)
    print(OUT)
    try:
        subprocess.run(["open", OUT], check=False)
    except FileNotFoundError:
        pass


if __name__ == "__main__":
    main()
