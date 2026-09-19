import type { Request, Response, NextFunction } from "express";
import type { ZodSchema } from "zod";

// errorStatus 기본 400(기존 라우트 계약 불변). 형식 오류를 422 로 구분해야 하는 라우트
// (예: knowledge-patterns 생성 — 감독 루프가 500/400 과 다르게 해석해야 함)는 422 를 지정한다.
export function validate(schema: ZodSchema, errorStatus = 400) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(errorStatus).json({ error: "Validation error", details: result.error.errors });
      return;
    }
    req.body = result.data;
    next();
  };
}
