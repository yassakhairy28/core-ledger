import express from "express";
import db_connection from "./DB/db_connection.js";

const appController = async (app: express.Application) => {

    await db_connection()
  app.get("/", (req, res) => res.send("Hello World!"));
};

export default appController;