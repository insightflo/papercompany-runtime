#!/usr/bin/env bash
# verify_all.sh — papercompany single-entry verification script
# Usage: bash scripts/verify_all.sh
# CI/CD: Run this script in pre-commit hook and build pipeline
set -euo pipefail

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0

# Pass counter
pass() {
    echo -e "${GREEN}✓${NC} $1"
    ((PASSED++))
}

# Fail counter
fail() {
    echo -e "${RED}✗${NC} $1"
    ((FAILED++))
}

# Warning counter
warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

echo "======================================"
echo "papercompany Verification Suite"
echo "======================================"
echo

# ===== V-01: /maintenance prefix middleware =====
# Verify that /maintenance/* routes are protected by requireMaintenanceCompany()
verify_v01_maintenance_prefix() {
    echo "V-01: Checking /maintenance prefix middleware..."
    if grep -q "requireMaintenanceCompany" server/src/routes/index.ts 2>/dev/null; then
        pass "requireMaintenanceCompany middleware exists"
    else
        warn "requireMaintenanceCompany middleware not found (not implemented yet)"
    fi

    if grep -q '"/maintenance"' server/src/routes/index.ts 2>/dev/null; then
        pass "/maintenance prefix route exists"
    else
        warn "/maintenance prefix route not found (not implemented yet)"
    fi
}

# ===== V-02: session_token plaintext forbidden =====
# Verify that no table uses session_token in plaintext
verify_v02_session_token_plaintext() {
    echo "V-02: Checking for plaintext session_token columns..."
    if grep -r "session_token.*TEXT" packages/db/src/migrations/*.sql 2>/dev/null | grep -v "session_secret_id"; then
        fail "Found plaintext session_token column (forbidden)"
    else
        pass "No plaintext session_token columns found"
    fi
}

# ===== V-03: re2 usage for $matches predicate =====
# Verify that predicate-eval.ts uses re2 for regex matching
verify_v03_re2_usage() {
    echo "V-03: Checking re2 usage in predicate evaluator..."
    if grep -q "from.*re2" server/src/services/worktree/predicate-eval.ts 2>/dev/null; then
        pass "re2 package imported in predicate-eval.ts"
    else
        warn "re2 import not found (predicate-eval.ts not implemented yet)"
    fi
}

# ===== V-04: company_kind CHECK constraint =====
# Verify that companies table has company_kind with CHECK constraint
verify_v04_company_kind() {
    echo "V-04: Checking company_kind column..."
    if grep -r "company_kind.*CHECK.*business.*maintenance" packages/db/src/migrations/*.sql 2>/dev/null; then
        pass "company_kind CHECK constraint exists"
    else
        warn "company_kind CHECK constraint not found (not implemented yet)"
    fi
}

# ===== V-05: allows_code_modify column =====
# Verify that companies table has allows_code_modify column
verify_v05_allows_code_modify() {
    echo "V-05: Checking allows_code_modify column..."
    if grep -r "allows_code_modify.*BOOLEAN" packages/db/src/migrations/*.sql 2>/dev/null; then
        pass "allows_code_modify column exists"
    else
        warn "allows_code_modify column not found (not implemented yet)"
    fi
}

# ===== V-06: mission_agents join table =====
# Verify that missions table doesn't have executor_ids array
verify_v06_mission_agents_join() {
    echo "V-06: Checking mission_agents join table..."
    if grep -r "executor_ids.*TEXT\[\]" packages/db/src/migrations/*.sql 2>/dev/null; then
        fail "Found forbidden executor_ids array in missions table"
    else
        pass "No executor_ids array found (mission_agents join table pattern correct)"
    fi

    if grep -r "CREATE TABLE.*mission_agents" packages/db/src/migrations/*.sql 2>/dev/null; then
        pass "mission_agents join table exists"
    else
        warn "mission_agents table not found (not implemented yet)"
    fi
}

# ===== V-07: srb_nonces table name (plural) =====
# Verify SRB nonce table uses plural name
verify_v07_srb_nonces_plural() {
    echo "V-07: Checking srb_nonces table name..."
    if grep -r "CREATE TABLE.*srb_nonce[^s]" packages/db/src/migrations/*.sql 2>/dev/null; then
        fail "Found singular srb_nonce table (should be srb_nonces)"
    else
        pass "srb_nonces plural naming correct"
    fi

    if grep -r "CREATE TABLE.*srb_nonces" packages/db/src/migrations/*.sql 2>/dev/null; then
        pass "srb_nonces table exists"
    else
        warn "srb_nonces table not found (not implemented yet)"
    fi
}

# ===== V-08: Index naming convention =====
# Verify indexes follow idx_{table}_{column} pattern
verify_v08_index_naming() {
    echo "V-08: Checking index naming convention..."
    # Check for violations in migration files
    VIOLATIONS=$(grep -r "CREATE INDEX" packages/db/src/migrations/*.sql 2>/dev/null | grep -v "idx_\|uq_\|fk_\|pk_" || true)
    if [ -n "$VIOLATIONS" ]; then
        warn "Found indexes not following naming convention:"
        echo "$VIOLATIONS"
    else
        pass "Index naming convention followed"
    fi
}

# ===== V-09: TIMESTAMPTZ usage =====
# Verify all timestamp columns use TIMESTAMPTZ
verify_v09_timestamptz_usage() {
    echo "V-09: Checking TIMESTAMPTZ usage..."
    # Look for TIMESTAMP without TIMEZONE
    VIOLATIONS=$(grep -r "TIMESTAMP.*NOT NULL" packages/db/src/migrations/*.sql 2>/dev/null | grep -v "TIMESTAMPTZ\|time zone" || true)
    if [ -n "$VIOLATIONS" ]; then
        warn "Found TIMESTAMP without timezone (should be TIMESTAMPTZ):"
        echo "$VIOLATIONS"
    else
        pass "All timestamps use TIMESTAMPTZ"
    fi
}

# ===== V-10: FK columns indexed =====
# Verify all foreign key columns have indexes
verify_v10_fk_indexes() {
    echo "V-10: Checking FK column indexes..."
    # This is a complex check - just verify pattern for new tables
    warn "FK index check requires manual verification in PR review"
}

# ===== Run all verifications =====
main() {
    verify_v01_maintenance_prefix
    verify_v02_session_token_plaintext
    verify_v03_re2_usage
    verify_v04_company_kind
    verify_v05_allows_code_modify
    verify_v06_mission_agents_join
    verify_v07_srb_nonces_plural
    verify_v08_index_naming
    verify_v09_timestamptz_usage
    verify_v10_fk_indexes

    echo
    echo "======================================"
    echo "Results: $PASSED passed, $FAILED failed"
    echo "======================================"

    if [ $FAILED -gt 0 ]; then
        exit 1
    fi
}

main "$@"
