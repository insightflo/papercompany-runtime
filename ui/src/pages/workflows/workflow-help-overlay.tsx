import { Fragment, type JSX } from "react";
import { mutedTextStyle } from "./workflow-page-styles.js";

export function WorkflowHelpOverlay({ onClose }: { onClose: () => void }): JSX.Element {
  return (
        <>
          <div
            key="help-overlay"
            style={{ position: "fixed", inset: 0, zIndex: 9998, background: "transparent" }}
            onClick={() => onClose()}
          />
          <div
            id="wf-help"
            key="help-popup"
            style={{
              position: "absolute",
              top: "44px",
              left: "100px",
              zIndex: 9999,
              width: "440px",
              maxHeight: "70vh",
              overflowY: "auto",
              padding: "16px",
              borderRadius: "10px",
              border: "1px solid var(--border, #334155)",
              background: "var(--card, #0f172a)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            }}
          >
            <div key="help-content" style={mutedTextStyle}>
              <p style={{ ...mutedTextStyle, fontWeight: 600, fontSize: "15px", marginBottom: "8px" }}>Workflow Engine 도움말</p>

              <p style={{ ...mutedTextStyle, fontWeight: 600, marginTop: "12px" }}>기본 개념</p>
              <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
                <li><strong>Workflow</strong>: 여러 Step으로 구성된 자동화 파이프라인</li>
                <li><strong>Step</strong>: Tool(시스템 실행) 또는 Agent(에이전트 작업) 유형</li>
                <li><strong>Tool Step</strong>: Tool Registry에 등록된 도구를 시스템이 직접 실행</li>
                <li><strong>Agent Step</strong>: 지정된 에이전트가 이슈를 받아 작업 수행</li>
              </ul>

              <p style={{ ...mutedTextStyle, fontWeight: 600, marginTop: "12px" }}>Step 설정</p>
              <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
                <li><strong>ID</strong>: 고유 식별자 (dependsOn에서 참조)</li>
                <li><strong>Type</strong>: Tool(도구 실행) / Agent(에이전트 작업)</li>
                <li><strong>Depends On</strong>: 선행 step ID (쉼표 구분, 비워두면 첫 step)</li>
                <li><strong>Tools</strong>: Agent step에서 사용할 도구 이름 (사용법이 자동 전달됨)</li>
                <li><strong>On Failure</strong>: 실패 시 정책 (retry/skip/abort)</li>
              </ul>

              <p style={{ ...mutedTextStyle, fontWeight: 600, marginTop: "12px" }}>변수</p>
              <p style={mutedTextStyle}>Step title에 사용 가능한 변수:</p>
              <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
                <li><code>{"{$date}"}</code> — 실행 날짜 (2026-03-25)</li>
                <li><code>{"{$runNumber}"}</code> — 당일 실행 번호 (1, 2, ...)</li>
                <li><code>{"{$runLabel}"}</code> — 실행 라벨 (#2026-03-25-1)</li>
                <li><code>{"{$workflowName}"}</code> — 워크플로우 이름</li>
              </ul>

              <p style={{ ...mutedTextStyle, fontWeight: 600, marginTop: "12px" }}>Schedule (Cron)</p>
              <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
                <li>형식: 분 시 일 월 요일 (예: <code>0 9 * * *</code> = 매일 9시)</li>
                <li>Reconciler가 5분 간격으로 체크하여 실행</li>
              </ul>
            </div>
          </div>
        </>
      )}

  );
}
