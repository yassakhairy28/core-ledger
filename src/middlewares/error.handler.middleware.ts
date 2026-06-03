import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";

export interface AppError extends Error {
  statusCode: number | undefined;
  details: string | undefined;
}

export const asyncHandler = <T extends RequestHandler>(
  fn: T,
): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): Promise<void> =>
    Promise.resolve(fn(req, res, next))
      .then(() => undefined)
      .catch(next);
};

export const globalErrorHandler: ErrorRequestHandler = (
  err: AppError,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;

  res.status(statusCode).json({
    message: err.message || "Internal server error",
    details: err.details,
  });
};

export const notFoundHanlder = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  res.status(404).json({ message: "Route not found" });
};

export class ApiError extends Error implements AppError {
  statusCode: number | undefined;
  details: string | undefined;

  constructor(message: string, statusCode?: number, details?: string) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}
