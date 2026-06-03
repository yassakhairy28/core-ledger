import express from "express";
import db_connection from "./DB/db_connection.js";
import ledgerRouter from "./routes/ledger.routes.js";
import {
  globalErrorHandler,
  notFoundHanlder,
} from "./middlewares/error.handler.middleware.js";

const appController = async (app: express.Application) => {
  app.use(express.json());
  await db_connection();
  app.get("/", (req, res) => res.send("Welcome to ledger-task Backend API!"));
  app.use("/api", ledgerRouter);

  app.all("/*dummy", notFoundHanlder);
  app.use(globalErrorHandler);
};

export default appController;
