const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");

const app = express();
const PORT = 3000;
const upload = multer({ dest: "uploads/" });

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));

const autoGeneratedHeaders = [
    "content-type", "user-agent", "accept", "cache-control", "postman-token",
    "host", "accept-encoding", "connection"
];

const isAlreadyProcessed = (collection) => collection.info?.name.includes("_Version");

const generateResponseTests = (responseBody, customTests = []) => {
    const tests = [];
    let parsedBody;

    try {
        parsedBody = JSON.parse(responseBody || '{}');
    } catch (e) {
        console.warn("Impossible de parser la réponse en JSON. Ignoré.");
        return tests;
    }

    Object.keys(parsedBody).forEach((key) => {
        const value = parsedBody[key];
        if (typeof value === "object") {
            tests.push(`pm.test("La réponse contient un champ '${key}'", function () {`);
            tests.push(`    pm.expect(pm.response.json()).to.have.property('${key}');`);
            tests.push("});");
        } else {
            tests.push(`pm.test("La réponse contient '${key}' avec la valeur attendue", function () {`);
            tests.push(`    pm.expect(pm.response.json()['${key}']).to.eql(${JSON.stringify(value)});`);
            tests.push("});");
        }
    });

    customTests.forEach(test => tests.push(test));
    return tests;
};

const addTestsToRequest = (item, expectedStatusCode, responseBody, customTests = []) => {
    if (!item.event) item.event = [];
    let testEvent = item.event.find((e) => e.listen === "test");

    if (!testEvent) {
        testEvent = { listen: "test", script: { exec: [], type: "text/javascript", packages: {} } };
        item.event.push(testEvent);
    }

    const scriptExec = testEvent.script.exec;

    if (!scriptExec.some(line => line.includes(`pm.test("Statut HTTP recherché`))) {
        scriptExec.push(
            `pm.test("Statut HTTP recherché: ${expectedStatusCode}", function () {`,
            `    pm.response.to.have.status(${expectedStatusCode});`,
            `});`
        );
    }

    if (!scriptExec.some(line => line.includes(`pm.test("Temps de réponse raisonnable`))) {
        scriptExec.push(
            `pm.test("Temps de réponse raisonnable", function () {`,
            `    pm.expect(pm.response.responseTime).to.be.below(1000);`,
            `});`
        );
    }

    generateResponseTests(responseBody, customTests).forEach(test => {
        if (!scriptExec.includes(test)) scriptExec.push(test);
    });
};

const processHeaders = (headers, collectionVariables) => {
    headers.forEach(header => {
        if (!autoGeneratedHeaders.includes(header.key.toLowerCase())) {
            const variableName = header.key.toUpperCase().replace(/-/g, "_");
            const variableReference = `{{${variableName}}}`;

            if (!collectionVariables.some(v => v.key === variableName)) {
                collectionVariables.push({ key: variableName, value: header.value });
            }

            header.value = variableReference;
        }
    });
};

const processItems = (items, concatNames, collectionVariables, customTests) => {
    const updatedItems = [];

    items.forEach((item) => {
        if (item.item && Array.isArray(item.item)) {
            item.item = processItems(item.item, concatNames, collectionVariables, customTests);
            updatedItems.push(item);
        } else if (item.request) {
            if (item.request.header) processHeaders(item.request.header, collectionVariables);

            if (item.request.url && item.request.url.raw.includes("http")) {
                const urlObject = new URL(item.request.url.raw);
                item.request.url.raw = `{{baseUrl}}${urlObject.pathname}${urlObject.search}`;
                item.request.url.host = ["{{baseUrl}}"];
            }

            if (item.response && Array.isArray(item.response)) {
                item.response.forEach((responseExample) => {
                    const newItem = JSON.parse(JSON.stringify(item));
                    if (concatNames) {
                        newItem.name = `${item.name} - ${responseExample.name || 'Réponse'}`;
                    }
                    newItem.response = [responseExample];
                    const statusCode = responseExample.code || 200;
                    addTestsToRequest(newItem, statusCode, responseExample.body, customTests);
                    updatedItems.push(newItem);
                });
            } else {
                updatedItems.push(item);
            }
        }
    });

    return updatedItems;
};

const modifyCollection = (data, version, customTests = [], concatNames = false) => {
    try {
        let collection = JSON.parse(data);
        if (isAlreadyProcessed(collection)) throw new Error("Fichier déjà optimisé.");

        const originalName = collection.info?.name || "Collection";
        const newCollectionName = `${originalName}_${version}`;

        if (collection.info) {
            collection.info.name = newCollectionName;
            collection.info.description = `version=${version} - ${collection.info.description || "Description non fournie."}`;
        }

        collection.variable = collection.variable?.filter(v => v.key !== "baseUrl") || [];
        const collectionVariables = collection.variable || [];

        collection.item = processItems(collection.item, concatNames, collectionVariables, customTests);
        collection.variable = collectionVariables;

        return { jsonData: JSON.stringify(collection, null, 2), newCollectionName };
    } catch (error) {
        throw new Error(error.message);
    }
};

app.get("/", (req, res) => res.render("index3", { message: null, error: null }));

app.post("/upload", upload.single("postmanCollection"), (req, res) => {
    if (!req.file) return res.render("index3", { message: "Aucun fichier téléchargé !", error: null });

    const version = req.body.version || "Non spécifiée";
    const customTests = req.body.customTests ? req.body.customTests.split("\n").filter(test => test.trim() !== "") : [];
    const concatNames = req.body.concatNames === 'on';
    const filePath = req.file.path;

    fs.readFile(filePath, "utf8", (err, data) => {
        if (err) return res.render("index3", { message: null, error: "Erreur lors de la lecture du fichier." });

        try {
            const { jsonData, newCollectionName } = modifyCollection(data, version, customTests, concatNames);
            const outputFilePath = path.join(__dirname, `${newCollectionName}.json`);

            fs.writeFileSync(outputFilePath, jsonData, "utf8");

            res.download(outputFilePath, `${newCollectionName}.json`, () => {
                fs.unlinkSync(filePath);
                fs.unlinkSync(outputFilePath);
            });
        } catch (error) {
            res.render("index3", { message: null, error: `Erreur : ${error.message}` });
        }
    });
});

app.listen(PORT, () => console.log(`✅ Serveur en ligne sur http://localhost:${PORT}`));
