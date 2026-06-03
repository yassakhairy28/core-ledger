import type { ObjectSchema } from "joi";
import { ApiError, asyncHandler } from "./error.handler.middleware.js";
import type { NextFunction, Request, Response } from "express";

export const validate = (schema: Record<string, ObjectSchema>) => {
  return asyncHandler(
    async (req: Request, res: Response, next: NextFunction) => {
      const schemaKeys = Object.keys(schema);

      if (!schemaKeys.length) {
        return next(new ApiError("No validation schema provided", 400));
      }

      const validationErrors: { key: string; errors: string[] }[] = [];

      for (const key of schemaKeys) {
        const { error } = schema[key]!.validate(req[key as keyof Request], {
          abortEarly: false,
        });

        if (error) {
          validationErrors.push({
            key,
            errors: error.details.map((e) => e.message),
          });
        }
      }

      if (validationErrors.length) {
        return res
          .status(400)
          .json({ message: "Validation Error", validationErrors });
      }

      next();
    },
  );
};
