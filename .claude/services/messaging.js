/**
 * Agent Messaging Service
 *
 * 에이전트 간 메시지 라우팅 서비스
 *
 * 기능:
 * - handoff.md 생성 시 수신 에이전트에게 자동 알림
 * - request.md에 대한 response.md 자동 생성 요청
 * - broadcast 메시지를 모든 관련 에이전트에게 전송
 *
 * @version 1.0.0
 * @updated 2026-03-03
 */

const fs = require('fs').promises;
const path = require('path');

/**
 * Agent Messaging Service 클래스
 */
class AgentMessagingService {
  /**
   * 생성자
   * @param {Object} options - 서비스 설정
   * @param {string} options.projectRoot - 프로젝트 루트 경로
   * @param {string} options.protocolDir - 프로토콜 템플릿 디렉토리
   * @param {string} options.managementDir - 관리 파일 디렉토리
   */
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || process.cwd();
    this.protocolDir = options.protocolDir ||
      path.join(this.projectRoot, 'project-team', 'templates', 'protocol');
    this.managementDir = options.managementDir ||
      path.join(this.projectRoot, 'management');

    // 메시지 큐
    this.messageQueue = [];
    this.messageHistory = [];
  }

  /**
   * Handoff 파일 생성 시 수신자에게 알림
   *
   * @param {string} handoffFile - handoff 파일 경로
   * @param {string} recipientAgent - 수신 에이전트 ID
   * @returns {Promise<Object>} 알림 결과
   */
  async notifyHandoff(handoffFile, recipientAgent) {
    try {
      // handoff 파일 읽기
      const handoffPath = path.join(this.managementDir, 'handoffs', handoffFile);
      const handoffContent = await fs.readFile(handoffPath, 'utf-8');

      // 메시지 생성
      const message = {
        type: 'handoff',
        id: this.generateMessageId(),
        timestamp: new Date().toISOString(),
        from: this.extractAgentFromHandoff(handoffContent),
        to: recipientAgent,
        subject: `Handoff: ${this.extractHandoffSubject(handoffContent)}`,
        content: handoffContent,
        actionRequired: true,
        protocol: 'handoff'
      };

      // 메시지 전송
      await this.deliverMessage(message);

      // 기록
      await this.recordMessage(message);

      return {
        success: true,
        messageId: message.id,
        recipient: recipientAgent,
        status: 'delivered'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        status: 'failed'
      };
    }
  }

  /**
   * Request에 대한 Response 요청
   *
   * @param {string} requestFile - request 파일 경로
   * @param {string} recipientAgent - 수신 에이전트 ID
   * @returns {Promise<Object>} 요청 결과
   */
  async requestResponse(requestFile, recipientAgent) {
    try {
      // request 파일 읽기
      const requestPath = path.join(this.managementDir, 'requests', requestFile);
      const requestContent = await fs.readFile(requestPath, 'utf-8');

      // 메시지 생성
      const message = {
        type: 'request',
        id: this.generateMessageId(),
        timestamp: new Date().toISOString(),
        from: this.extractRequestFrom(requestContent),
        to: recipientAgent,
        subject: `Request: ${this.extractRequestSubject(requestContent)}`,
        content: requestContent,
        actionRequired: true,
        protocol: 'request-response',
        expectsResponse: true,
        responseTemplate: path.join(this.protocolDir, 'response.md')
      };

      // 메시지 전송
      await this.deliverMessage(message);

      // 기록
      await this.recordMessage(message);

      // response 파일 템플릿 생성
      const responseFile = requestFile.replace('request-', 'response-');
      await this.createResponseTemplate(responseFile, message);

      return {
        success: true,
        messageId: message.id,
        recipient: recipientAgent,
        responseFile: `management/responses/${responseFile}`,
        status: 'pending_response'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        status: 'failed'
      };
    }
  }

  /**
   * 도메인 변경 시 관련 에이전트들에게 브로드캐스트
   *
   * @param {Object} change - 도메인 변경 정보
   * @param {Array<string>} affectedDomains - 영향받는 도메인 목록
   * @returns {Promise<Object>} 브로드캐스트 결과
   */
  async broadcastDomainChange(change, affectedDomains) {
    const results = [];

    for (const domain of affectedDomains) {
      // 도메인별 수신 에이전트 결정
      const recipients = this.getDomainAgents(domain);

      for (const recipient of recipients) {
        const message = {
          type: 'broadcast',
          id: this.generateMessageId(),
          timestamp: new Date().toISOString(),
          from: change.initiator || 'system',
          to: recipient,
          subject: `Domain Change: ${change.domain}`,
          content: {
            domain: change.domain,
            changeType: change.type,
            description: change.description,
            breakingChanges: change.breakingChanges || [],
            affectedApis: change.affectedApis || [],
            migrationRequired: change.migrationRequired || false
          },
          actionRequired: change.actionRequired || false,
          protocol: 'broadcast',
          priority: change.severity || 'medium'
        };

        try {
          await this.deliverMessage(message);
          await this.recordMessage(message);
          results.push({
            recipient,
            status: 'delivered',
            messageId: message.id
          });
        } catch (error) {
          results.push({
            recipient,
            status: 'failed',
            error: error.message
          });
        }
      }
    }

    return {
      success: true,
      totalRecipients: results.length,
      delivered: results.filter(r => r.status === 'delivered').length,
      failed: results.filter(r => r.status === 'failed').length,
      results
    };
  }

  /**
   * 에이전트에게 직접 메시지 전송
   *
   * @param {string} agentId - 수신 에이전트 ID
   * @param {Object} messageData - 메시지 데이터
   * @returns {Promise<Object>} 전송 결과
   */
  async notifyAgent(agentId, messageData) {
    const message = {
      type: 'direct',
      id: this.generateMessageId(),
      timestamp: new Date().toISOString(),
      from: messageData.from || 'system',
      to: agentId,
      subject: messageData.subject || '',
      content: messageData.content || messageData,
      actionRequired: messageData.actionRequired || false,
      protocol: 'direct',
      priority: messageData.priority || 'normal'
    };

    try {
      await this.deliverMessage(message);
      await this.recordMessage(message);

      return {
        success: true,
        messageId: message.id,
        recipient: agentId,
        status: 'delivered'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        status: 'failed'
      };
    }
  }

  /**
   * 메시지 전송 (구현체)
   *
   * 실제 환경에서는 Claude의 SendMessage tool을 사용하거나,
   * 다른 메시징 시스템과 연동합니다.
   *
   * @private
   * @param {Object} message - 메시지 객체
   */
  async deliverMessage(message) {
    // 현재는 파일 시스템에 메시지를 저장하는 방식으로 구현
    const inboxDir = path.join(this.managementDir, 'inbox', message.to);

    // inbox 디렉토리 생성
    await fs.mkdir(inboxDir, { recursive: true });

    // 메시지 파일 저장
    const messageFile = path.join(inboxDir, `${message.id}.json`);
    await fs.writeFile(messageFile, JSON.stringify(message, null, 2), 'utf-8');

    // TODO: 실제 환경에서는 Claude SendMessage tool 또는 다른 메시징 시스템 사용
    // 예: SendMessage({ type: 'message', recipient: message.to, content: message.content })
  }

  /**
   * 메시지 기록
   *
   * @private
   * @param {Object} message - 메시지 객체
   */
  async recordMessage(message) {
    this.messageHistory.push(message);

    // 히스토리 파일에도 저장
    const historyFile = path.join(this.managementDir, 'message-history.jsonl');
    const historyEntry = JSON.stringify({
      ...message,
      recordedAt: new Date().toISOString()
    });

    await fs.appendFile(historyFile, historyEntry + '\n', 'utf-8');
  }

  /**
   * Response 파일 템플릿 생성
   *
   * @private
   * @param {string} responseFile - response 파일명
   * @param {Object} originalMessage - 원본 메시지
   */
  async createResponseTemplate(responseFile, originalMessage) {
    const responseDir = path.join(this.managementDir, 'responses');
    await fs.mkdir(responseDir, { recursive: true });

    const responsePath = path.join(responseDir, responseFile);

    // response 템플릿 내용
    const template = `# Response to: ${originalMessage.subject}

**From**: ${originalMessage.to}
**To**: ${originalMessage.from}
**Date**: ${new Date().toISOString()}
**Response ID**: res-${Date.now()}
**Original Message ID**: ${originalMessage.id}

---

## 1. 응답 개요

### 요약
{요약 내용}

### 결정
- [ ] 승인 (Approved)
- [ ] 조건부 승인 (Conditional)
- [ ] 거부 (Rejected)
- [ ] 검토 필요 (Review Required)

---

## 2. 응답 내용

### 분석 결과
{분석 내용}

### 제안 사항
{제안 내용}

### 다음 단계
1. {다음 단계 1}
2. {다음 단계 2}

---

## 3. 참조

### 원본 요청
\`\`\`
${originalMessage.content ? originalMessage.content.substring(0, 500) + '...' : ''}
\`\`\`

---

**상태**: 작성 중 → 검토 대기 → 전송 완료
**마지막 업데이트**: ${new Date().toISOString()}
`;

    await fs.writeFile(responsePath, template, 'utf-8');
  }

  /**
   * 도메인별 에이전트 목록 가져오기
   *
   * @private
   * @param {string} domain - 도메인명
   * @returns {Array<string>} 에이전트 ID 목록
   */
  getDomainAgents(domain) {
    const domainAgentMap = {
      'backend': ['backend-specialist', 'dba'],
      'frontend': ['frontend-specialist', 'chief-designer'],
      'security': ['security-specialist'],
      'quality': ['qa-manager'],
      'architecture': ['chief-architect'],
      'project': ['project-manager'],
      'all': ['project-manager', 'chief-architect', 'chief-designer', 'qa-manager',
               'security-specialist', 'backend-specialist', 'frontend-specialist', 'dba']
    };

    return domainAgentMap[domain] || [`${domain}-part-leader`];
  }

  /**
   * handoff 내용에서 발신 에이전트 추출
   *
   * @private
   * @param {string} content - handoff 파일 내용
   * @returns {string} 발신 에이전트 ID
   */
  extractAgentFromHandoff(content) {
    const match = content.match(/\*\*인계자\*\*:\s*(.+)/);
    return match ? match[1].trim() : 'unknown';
  }

  /**
   * handoff 제목 추출
   *
   * @private
   * @param {string} content - handoff 파일 내용
   * @returns {string} 제목
   */
  extractHandoffSubject(content) {
    const match = content.match(/# Handoff:\s*(.+)/);
    return match ? match[1].trim() : 'Unknown Handoff';
  }

  /**
   * request 발신자 추출
   *
   * @private
   * @param {string} content - request 파일 내용
   * @returns {string} 발신자 ID
   */
  extractRequestFrom(content) {
    const match = content.match(/\*\*From\*\*:\s*(.+)/);
    return match ? match[1].trim() : 'unknown';
  }

  /**
   * request 제목 추출
   *
   * @private
   * @param {string} content - request 파일 내용
   * @returns {string} 제목
   */
  extractRequestSubject(content) {
    const match = content.match(/## Request:\s*(.+)/);
    return match ? match[1].trim() : 'Unknown Request';
  }

  /**
   * 메시지 ID 생성
   *
   * @private
   * @returns {string} 메시지 ID
   */
  generateMessageId() {
    return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 메시지 히스토리 조회
   *
   * @param {Object} filters - 필터 조건
   * @returns {Promise<Array>} 메시지 목록
   */
  async getMessageHistory(filters = {}) {
    let messages = this.messageHistory;

    if (filters.type) {
      messages = messages.filter(m => m.type === filters.type);
    }
    if (filters.from) {
      messages = messages.filter(m => m.from === filters.from);
    }
    if (filters.to) {
      messages = messages.filter(m => m.to === filters.to);
    }
    if (filters.startDate) {
      messages = messages.filter(m => new Date(m.timestamp) >= new Date(filters.startDate));
    }

    return messages;
  }

  /**
   * 에이전트 inbox 조회
   *
   * @param {string} agentId - 에이전트 ID
   * @returns {Promise<Array>} 수신 메시지 목록
   */
  async getAgentInbox(agentId) {
    const inboxDir = path.join(this.managementDir, 'inbox', agentId);

    try {
      const files = await fs.readdir(inboxDir);
      const messages = [];

      for (const file of files) {
        const filePath = path.join(inboxDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        messages.push(JSON.parse(content));
      }

      // 타임스탬프순 정렬 (최신 먼저)
      return messages.sort((a, b) =>
        new Date(b.timestamp) - new Date(a.timestamp)
      );
    } catch (error) {
      // inbox가 없으면 빈 배열 반환
      return [];
    }
  }
}

// CLI 실행 모드
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  const messaging = new AgentMessagingService();

  switch (command) {
    case 'notify-handoff':
      // node messaging.js notify-handoff <handoffFile> <recipientAgent>
      messaging.notifyHandoff(args[1], args[2])
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(err => console.error('Error:', err.message));
      break;

    case 'request-response':
      // node messaging.js request-response <requestFile> <recipientAgent>
      messaging.requestResponse(args[1], args[2])
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(err => console.error('Error:', err.message));
      break;

    case 'broadcast':
      // node messaging.js broadcast <changeJson> <affectedDomains...>
      const change = JSON.parse(args[1]);
      const domains = args.slice(2);
      messaging.broadcastDomainChange(change, domains)
        .then(result => console.log(JSON.stringify(result, null, 2)))
        .catch(err => console.error('Error:', err.message));
      break;

    case 'inbox':
      // node messaging.js inbox <agentId>
      messaging.getAgentInbox(args[1])
        .then(messages => console.log(JSON.stringify(messages, null, 2)))
        .catch(err => console.error('Error:', err.message));
      break;

    default:
      console.log(`
Agent Messaging Service

Usage:
  node messaging.js notify-handoff <handoffFile> <recipientAgent>
  node messaging.js request-response <requestFile> <recipientAgent>
  node messaging.js broadcast <changeJson> <affectedDomains...>
  node messaging.js inbox <agentId>

Examples:
  node messaging.js notify-handoff hof-backend-123.md frontend-part-leader
  node messaging.js request-response req-api-change.md backend-specialist
  node messaging.js broadcast '{"type":"breaking","domain":"api"}' backend frontend
  node messaging.js inbox qa-manager
      `);
  }
}

module.exports = AgentMessagingService;
