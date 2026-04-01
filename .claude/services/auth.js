/**
 * Agent Authentication/Authorization Service
 *
 * 에이전트 인증/인가 서비스
 *
 * 기능:
 * - JWT 토큰 발급 (에이전트 시작 시)
 * - 토큰 검증 (Hook에서)
 * - 권한 상승 서명 (VIBE 패턴)
 *
 * @version 1.0.0
 * @updated 2026-03-03
 *
 * 보안 참고:
 * - 프로덕션 환경에서는 SECRET_KEY를 환경변수 또는 안전한 저장소에서 가져오세요
 * - 토큰 만료 시간은 보안 요구사항에 따라 조정하세요
 */

const crypto = require('crypto');
const { resolveRoleIdentity } = require('../hooks/lib/deterministic-policy');

const DEFAULT_SECRET_KEY = 'default-secret-key-change-in-production';

function resolveTokenSecret(explicitSecret) {
  return explicitSecret
    || process.env.CLAUDE_HOOK_SECRET
    || process.env.AGENT_JWT_SECRET
    || process.env.PERMISSION_CHECKER_SECRET
    || DEFAULT_SECRET_KEY;
}

function nowInSeconds(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000);
}

function normalizeTokenExpiration(exp) {
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return null;
  }

  return exp > 1e12 ? Math.floor(exp / 1000) : Math.floor(exp);
}

function isTokenExpired(exp, nowMs = Date.now()) {
  const normalizedExp = normalizeTokenExpiration(exp);
  if (normalizedExp === null) {
    return true;
  }

  return normalizedExp <= nowInSeconds(nowMs);
}

function resolveExpiresInSeconds(expiresInMs, explicitExpiresInSeconds, fallbackMs) {
  if (typeof explicitExpiresInSeconds === 'number' && Number.isFinite(explicitExpiresInSeconds)) {
    return Math.max(0, Math.floor(explicitExpiresInSeconds));
  }

  const ms = typeof expiresInMs === 'number' && Number.isFinite(expiresInMs)
    ? expiresInMs
    : fallbackMs;

  return Math.max(0, Math.floor(ms / 1000));
}

function buildAgentTokenPayload({
  agentId,
  role,
  domain,
  expiresIn,
  expiresInSeconds,
  scopeId,
  allowedPaths,
  reviewOnly,
  type,
  allowedTools,
  deniedTools,
  advisoryOnly,
  extraClaims
}) {
  const iat = nowInSeconds();
  const payload = {
    role,
    scope_id: scopeId || agentId || role,
    allowed_paths: Array.isArray(allowedPaths) ? allowedPaths : [],
    review_only: reviewOnly === true,
    iat,
    exp: iat + resolveExpiresInSeconds(expiresIn, expiresInSeconds, 3600000)
  };

  if (domain) {
    payload.domain = domain;
  }

  if (type) {
    payload.type = type;
  }

  if (agentId) {
    payload.agentId = agentId;
  }

  if (Array.isArray(allowedTools)) {
    payload.allowed_tools = allowedTools;
  }

  if (Array.isArray(deniedTools)) {
    payload.denied_tools = deniedTools;
  }

  if (typeof advisoryOnly === 'boolean') {
    payload.advisory_only = advisoryOnly;
  }

  if (extraClaims && typeof extraClaims === 'object') {
    Object.assign(payload, extraClaims);
  }

  return payload;
}

/**
 * HMAC-SHA256 기반 간단 JWT 구현
 * (node-jsonwebtoken 의존성 없이 동작)
 */
class SimpleJWT {
  constructor(secret) {
    this.secret = secret;
  }

  /**
   * JWT 서명 생성
   * @param {string} header - Base64URL 인코딩된 헤더
   * @param {string} payload - Base64URL 인코딩된 페이로드
   * @returns {string} 서명
   */
  sign(header, payload) {
    const data = `${header}.${payload}`;
    return crypto.createHmac('sha256', this.secret)
      .update(data)
      .digest('base64url');
  }

  /**
   * JWT 토큰 생성
   * @param {object} payload - 페이로드 데이터
   * @returns {string} JWT 토큰
   */
  encode(payload) {
    const header = {
      alg: 'HS256',
      typ: 'JWT'
    };

    const headerEncoded = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadEncoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = this.sign(headerEncoded, payloadEncoded);

    return `${headerEncoded}.${payloadEncoded}.${signature}`;
  }

  /**
   * JWT 토큰 검증 및 디코딩
   * @param {string} token - JWT 토큰
   * @returns {object|null} 디코딩된 페이로드 또는 null (검증 실패)
   */
  decode(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;

      const [headerEncoded, payloadEncoded, signature] = parts;

      // 서명 검증
      const expectedSignature = this.sign(headerEncoded, payloadEncoded);
      if (signature !== expectedSignature) return null;

      // 페이로드 디코딩
      const payload = JSON.parse(Buffer.from(payloadEncoded, 'base64url').toString());

      // 만료 시간 검증
      if (payload.exp !== undefined && isTokenExpired(payload.exp)) {
        return null;
      }

      return payload;
    } catch (error) {
      return null;
    }
  }
}

/**
 * Agent Authentication Service 클래스
 */
class AgentAuthService {
  /**
   * 생성자
   * @param {Object} options - 서비스 설정
   * @param {string} options.secretKey - JWT 서명 키 (기본값: 환경변수 또는 기본 키)
   */
  constructor(options = {}) {
    this.secretKey = resolveTokenSecret(options.secretKey); // 프로덕션에서는 반드시 변경

    this.jwt = new SimpleJWT(this.secretKey);

    // 권한 매트릭스
    this.permissionMatrix = this.loadPermissionMatrix();
  }

  /**
   * 권한 매트릭스 로드
   * @returns {Object} 역할별 권한 매트릭스
   */
  loadPermissionMatrix() {
    return {
      lead: {
        canCreateTasks: true,
        canAssignTasks: true,
        canApproveDeployment: true,
        canModifyArchitecture: true,
        canModifyDesign: false,
        canChangeQualityStandards: true,
        canAccessAllDomains: false
      },
      reviewer: {
        canCreateTasks: false,
        canAssignTasks: false,
        canApproveDeployment: true,
        canModifyArchitecture: false,
        canModifyDesign: false,
        canChangeQualityStandards: true,
        canAccessAllDomains: true,
        vetoAuthority: true
      },
      'security-specialist': {
        canCreateTasks: false,
        canAssignTasks: false,
        canApproveDeployment: true,
        canModifyArchitecture: false,
        canModifyDesign: false,
        canChangeQualityStandards: false,
        canAccessAllDomains: true,
        vetoAuthority: true
      },
      builder: {
        canCreateTasks: false,
        canAssignTasks: false,
        canApproveDeployment: false,
        canModifyArchitecture: false,
        canModifyDesign: false,
        canChangeQualityStandards: false,
        canAccessAllDomains: false,
        allowedDomains: ['backend', 'api', 'frontend', 'ui', 'ux', 'database']
      },
      designer: {
        canCreateTasks: false,
        canAssignTasks: false,
        canApproveDeployment: false,
        canModifyArchitecture: false,
        canModifyDesign: true,
        canChangeQualityStandards: false,
        canAccessAllDomains: false,
        allowedDomains: ['frontend', 'ui', 'ux']
      },
      'dba': {
        canCreateTasks: false,
        canAssignTasks: false,
        canApproveDeployment: true,
        canModifyArchitecture: false,
        canModifyDesign: false,
        canChangeQualityStandards: false,
        canAccessAllDomains: false,
        allowedDomains: ['database', 'migration'],
        vetoAuthority: true
      }
    };
  }

  resolvePermissionRole(role) {
    const identity = resolveRoleIdentity(role);
    if (identity && identity.recognized && identity.canonicalRole) {
      return identity.canonicalRole;
    }

    return typeof role === 'string' ? role.toLowerCase().trim() : role;
  }

  /**
   * 에이전트 시작에 토큰 발급
   * @param {string} agentId - 에이전트 ID
   * @param {string} role - 역할
   * @param {string} domain - 도메인
   * @param {number} expiresIn - 만료 시간 (밀리초, 기본값: 1시간)
   * @returns {string} JWT 토큰
   */
  issueToken(agentId, role, domain, expiresIn = 3600000, options = {}) {
    const payload = buildAgentTokenPayload({
      agentId,
      role,
      domain,
      expiresIn,
      expiresInSeconds: options.expiresInSeconds,
      scopeId: options.scopeId,
      allowedPaths: options.allowedPaths,
      reviewOnly: options.reviewOnly,
      type: options.type,
      allowedTools: options.allowedTools,
      deniedTools: options.deniedTools,
      advisoryOnly: options.advisoryOnly,
      extraClaims: options.extraClaims
    });

    return this.jwt.encode(payload);
  }

  /**
   * 토큰 검증
   * @param {string} token - JWT 토큰
   * @returns {Object|null} 검증 결과
   */
  verifyToken(token) {
    const payload = this.jwt.decode(token);

    if (!payload) {
      return {
        valid: false,
        error: 'Invalid token'
      };
    }

    return {
      valid: true,
      agentId: payload.agentId,
      role: payload.role,
      domain: payload.domain,
      scopeId: payload.scope_id,
      allowedPaths: payload.allowed_paths,
      reviewOnly: payload.review_only,
      allowedTools: payload.allowed_tools,
      deniedTools: payload.denied_tools,
      advisoryOnly: payload.advisory_only,
      type: payload.type,
      iat: payload.iat,
      exp: normalizeTokenExpiration(payload.exp)
    };
  }

  /**
   * 권한 확인
   * @param {string} role - 역할
   * @param {string} permission - 권한명
   * @returns {boolean} 권한 여부
   */
  hasPermission(role, permission) {
    const canonicalRole = this.resolvePermissionRole(role);
    const rolePermissions = this.permissionMatrix[canonicalRole];
    if (!rolePermissions) return false;

    return rolePermissions[permission] === true;
  }

  /**
   * 도메인 접근 권한 확인
   * @param {string} role - 역할
   * @param {string} targetDomain - 대상 도메인
   * @returns {boolean} 접근 권한 여부
   */
  canAccessDomain(role, targetDomain) {
    const canonicalRole = this.resolvePermissionRole(role);
    const rolePermissions = this.permissionMatrix[canonicalRole];
    if (!rolePermissions) return false;

    // 전체 접근 권한
    if (rolePermissions.canAccessAllDomains) return true;

    // 허용된 도메인 목록 확인
    const allowedDomains = rolePermissions.allowedDomains || [];
    return allowedDomains.includes(targetDomain);
  }

  /**
   * VETO 권한 확인
   * @param {string} role - 역할
   * @returns {boolean} VETO 권한 여부
   */
  hasVetoAuthority(role) {
    const canonicalRole = this.resolvePermissionRole(role);
    const rolePermissions = this.permissionMatrix[canonicalRole];
    return rolePermissions && rolePermissions.vetoAuthority === true;
  }

  /**
   * 권한 상승 서명 생성 (VIBE 패턴)
   * @param {string} requestor - 요청자 에이전트 ID
   * @param {string} target - 대상 에이전트 ID
   * @param {string} reason - 권한 상승 사유
   * @param {number} expiresIn - 만료 시간 (밀리초, 기본값: 5분)
   * @returns {string} 권한 상승 토큰
   */
  createEscalationToken(requestor, target, reason, expiresIn = 300000, options = {}) {
    const payload = buildAgentTokenPayload({
      agentId: options.agentId || target,
      role: options.role || requestor,
      domain: options.domain,
      expiresIn,
      expiresInSeconds: options.expiresInSeconds,
      scopeId: options.scopeId || target,
      allowedPaths: options.allowedPaths,
      reviewOnly: options.reviewOnly,
      type: 'escalation',
      allowedTools: options.allowedTools,
      deniedTools: options.deniedTools,
      advisoryOnly: options.advisoryOnly,
      extraClaims: {
        requestor,
        target,
        reason,
        ...(options.extraClaims || {})
      }
    });

    return this.jwt.encode(payload);
  }

  /**
   * 권한 상승 토큰 검증
   * @param {string} token - 권한 상승 토큰
   * @returns {Object|null} 검증 결과
   */
  verifyEscalationToken(token) {
    const payload = this.jwt.decode(token);

    if (!payload || payload.type !== 'escalation') {
      return null;
    }

    return {
      valid: true,
      requestor: payload.requestor,
      target: payload.target,
      reason: payload.reason
    };
  }

  /**
   * Hook에서의 토큰 검증 (통합 메서드)
   * @param {string} toolInput - Hook 입력값
   * @param {Object} options - 옵션
   * @returns {Object} 검증 결과
   */
  checkHookPermission(toolInput, options = {}) {
    const {
      requiredPermission = null,
      targetDomain = null,
      requireVeto = false
    } = options;

    // 환경변수에서 토큰 가져오기 (폴백)
    const agentToken = toolInput.agentToken ||
      process.env.CLAUDE_AGENT_TOKEN ||
      toolInput.metadata?.agentToken;

    if (!agentToken) {
      return {
        decision: 'deny',
        reason: 'No agent token provided'
      };
    }

    // 토큰 검증
    const verification = this.verifyToken(agentToken);
    if (!verification.valid) {
      return {
        decision: 'deny',
        reason: 'Invalid token',
        error: verification.error
      };
    }

    const { role, agentId } = verification;

    // VETO 권한 확인
    if (requireVeto && !this.hasVetoAuthority(role)) {
      return {
        decision: 'deny',
        reason: `Role ${role} does not have VETO authority`,
        agentId
      };
    }

    // 특정 권한 확인
    if (requiredPermission && !this.hasPermission(role, requiredPermission)) {
      return {
        decision: 'deny',
        reason: `Role ${role} does not have permission: ${requiredPermission}`,
        agentId
      };
    }

    // 도메인 접근 권한 확인
    if (targetDomain && !this.canAccessDomain(role, targetDomain)) {
      return {
        decision: 'deny',
        reason: `Role ${role} cannot access domain: ${targetDomain}`,
        agentId
      };
    }

    return {
      decision: 'allow',
      agentId,
      role
    };
  }

  /**
   * 파일 경로 접근 권한 확인
   * @param {string} role - 역할
   * @param {string} filePath - 파일 경로
   * @returns {boolean} 접근 권한 여부
   */
  canAccessFile(role, filePath) {
    // 보안 관련 파일
    if (filePath.includes('.env') || filePath.includes('secret')) {
      return this.hasPermission(role, 'canAccessSecurityFiles') ||
        this.canAccessDomain(role, 'security');
    }

    // 설계 파일
    if (filePath.includes('design/') || filePath.includes('components/')) {
      return this.hasPermission(role, 'canModifyDesign') ||
        this.canAccessDomain(role, 'frontend');
    }

    // 아키텍처 파일
    if (filePath.includes('architecture/') || filePath.includes('contracts/')) {
      return this.hasPermission(role, 'canModifyArchitecture') ||
        this.canAccessAllDomains(role);
    }

    return true;
  }

  /**
   * 전체 접근 권한 확인
   * @param {string} role - 역할
   * @returns {boolean}
   */
  canAccessAllDomains(role) {
    const canonicalRole = this.resolvePermissionRole(role);
    const rolePermissions = this.permissionMatrix[canonicalRole];
    return rolePermissions && rolePermissions.canAccessAllDomains === true;
  }
}

// CLI 실행 모드
if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0];

  const auth = new AgentAuthService();

  switch (command) {
    case 'issue':
      // node auth.js issue <agentId> <role> <domain>
      const token = auth.issueToken(args[1], args[2], args[3]);
      console.log(token);
      break;

    case 'verify':
      // node auth.js verify <token>
      const verification = auth.verifyToken(args[1]);
      console.log(JSON.stringify(verification, null, 2));
      break;

    case 'escalate':
      // node auth.js escalate <requestor> <target> <reason>
      const escalationToken = auth.createEscalationToken(args[1], args[2], args[3]);
      console.log(escalationToken);
      break;

    case 'permissions':
      // node auth.js permissions <role>
      const role = args[1];
      const permissions = auth.permissionMatrix[auth.resolvePermissionRole(role)];
      console.log(JSON.stringify(permissions, null, 2));
      break;

    default:
      console.log(`
Agent Authentication Service

Usage:
  node auth.js issue <agentId> <role> <domain>
  node auth.js verify <token>
  node auth.js escalate <requestor> <target> <reason>
  node auth.js permissions <role>

Examples:
  node auth.js issue agent-123 builder backend
  node auth.js verify eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
  node auth.js escalate agent-123 agent-456 "Deployment approval needed"
  node auth.js permissions reviewer
       `);
  }
}

module.exports = AgentAuthService;
module.exports.DEFAULT_SECRET_KEY = DEFAULT_SECRET_KEY;
module.exports.resolveTokenSecret = resolveTokenSecret;
module.exports.nowInSeconds = nowInSeconds;
module.exports.normalizeTokenExpiration = normalizeTokenExpiration;
module.exports.isTokenExpired = isTokenExpired;
module.exports.buildAgentTokenPayload = buildAgentTokenPayload;
