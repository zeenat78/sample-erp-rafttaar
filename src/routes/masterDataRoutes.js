import { Router } from "express";
import * as c from "../controllers/rafttaarController.js";

export const locationRoutes = Router();
locationRoutes.get("/", c.locList);
locationRoutes.post("/refresh", c.locRefresh); // pull carrierStatus from Rafttaar
locationRoutes.put("/:externalId", c.locUpsert); // create/update locally, then PUT /locations/{externalId}
locationRoutes.post("/:externalId/sync", c.locSync);
locationRoutes.post("/:externalId/deactivate", c.locDeactivate);

export const inventoryRoutes = Router();
inventoryRoutes.get("/", c.invList);
inventoryRoutes.put("/", c.invUpsert); // save locally, then PUT /inventory (?sync=false to only save)
inventoryRoutes.post("/sync", c.invSync);
inventoryRoutes.delete("/:id", c.invDelete);
