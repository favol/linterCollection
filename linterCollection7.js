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

const extractRequestName = (item) => {
    if (item.request && item.request.url) {
        if (item.request.url.raw.includes("{{")) {
            return item.request.url.raw.replace(/{{.*?}}/, "").trim();
        } else {
            try {
                const urlObject = new URL(item.request.url.raw);
                return `${urlObject.pathname}${urlObject.search}`.trim();
            } catch (error) {
                return item.name;
            }
        }
    }
    return item.name;
};

const generateResponseTests = (responseBody, customTests = [], requestName) => {
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
            tests.push(`    pm.expect(pm.response.json()).to.have.property('${key}');});`);
            tests.push("});");
        } else {
            tests.push(`pm.test("La réponse contient '${key}' avec la valeur attendue", function () {`);
            tests.push(`    pm.expect(pm.response.json()['${key}']).to.eql(${JSON.stringify(value)});});`);
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
    const requestName = extractRequestName(item);

    if (!scriptExec.some(line => line.includes(`pm.test("[${requestName}] - Statut HTTP recherché`))) {
        scriptExec.push(
            `pm.test("[${requestName}] - Statut HTTP recherché: ${expectedStatusCode}", function () {`,
            `    pm.response.to.have.status(${expectedStatusCode});`,
            `});`
        );
    }

    if (!scriptExec.some(line => line.includes(`pm.test("[${requestName}] - Temps de réponse raisonnable`))) {
        scriptExec.push(
            `pm.test("[${requestName}] - Temps de réponse raisonnable", function () {`,
            `    pm.expect(pm.response.responseTime).to.be.below(1000);`,
            `});`
        );
    }

    generateResponseTests(responseBody, customTests, requestName).forEach(test => {
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

// Fonction qui modifie les items en fonction de la variable d'URL personnalisée
const processItems = (items, concatNames, environmentVariables, customTests, urlVariable) => {
    const updatedItems = [];

    items.forEach((item) => {
        if (item.item && Array.isArray(item.item)) {
            item.item = processItems(item.item, concatNames, environmentVariables, customTests, urlVariable);
            updatedItems.push(item);
        } else if (item.request) {
            if (item.request.header) processHeaders(item.request.header, environmentVariables);

            // Remplacer toutes les occurrences de {{baseUrl}} par la variable d'URL définie par l'utilisateur
            if (item.request.url && item.request.url.raw.includes("{{baseUrl}}")) {
                item.request.url.raw = item.request.url.raw.replace("{{baseUrl}}", `{{${urlVariable}}}`);
                item.request.url.host = [`{{${urlVariable}}}`];
            }

            if (item.response && Array.isArray(item.response)) {
                item.response.forEach((responseExample) => {
                    const newItem = JSON.parse(JSON.stringify(item));
                    newItem.name = concatNames
                        ? `${extractRequestName(item)} - ${responseExample.name || 'Réponse'}`
                        : extractRequestName(item);

                    newItem.response = [responseExample];
                    const statusCode = responseExample.code || 200;
                    addTestsToRequest(newItem, statusCode, responseExample.body, customTests);
                    updatedItems.push(newItem);
                });
            } else {
                item.name = extractRequestName(item);
                updatedItems.push(item);
            }
        }
    });

    return updatedItems;
};

const modifyCollection = (data, version, customTests = [], concatNames = false, urlVariable = "baseUrl") => {
    try {
        let collection = JSON.parse(data);
        if (isAlreadyProcessed(collection)) throw new Error("Fichier déjà optimisé.");

        const originalName = collection.info?.name || "Collection";
        const newCollectionName = `${originalName}_${version}`;

        if (collection.info) {
            collection.info.name = newCollectionName;
            collection.info.description = `version=${version} - ${collection.info.description || "Description non fournie."}`;
        }

        // Nouvelle section pour les variables d'environnement
        const environment = {
            "id": "environment-id",
            "name": "Environment for " + newCollectionName,
            "values": [
                { "key": urlVariable, "value": "https://", "enabled": true }
            ]
        };

        // Ajouter les variables à l'environnement
        const environmentVariables = environment.values || [];

        collection.item = processItems(collection.item, concatNames, environmentVariables, customTests, urlVariable);

        // Retourner l'environnement et la collection modifiée
        return { jsonData: JSON.stringify(collection, null, 2), environmentData: JSON.stringify(environment, null, 2), newCollectionName };
    } catch (error) {
        throw new Error(error.message);
    }
};

app.get("/", (req, res) => res.render("index4", { message: null, error: null }));

app.post("/upload", upload.single("postmanCollection"), (req, res) => {
    if (!req.file) return res.render("index4", { message: "Aucun fichier téléchargé !", error: null });

    const version = req.body.version || "Non spécifiée";
    const customTests = req.body.customTests ? req.body.customTests.split("\n").filter(test => test.trim() !== "") : [];
    const concatNames = req.body.concatNames === 'on';
    const urlVariable = req.body.baseVariable?.trim() || "baseUrl";  // Utilisation du champ baseVariable du formulaire
    const filePath = req.file.path;

    fs.readFile(filePath, "utf8", (err, data) => {
        if (err) return res.render("index4", { message: null, error: "Erreur lors de la lecture du fichier." });

        try {
            const { jsonData, environmentData, newCollectionName } = modifyCollection(data, version, customTests, concatNames, urlVariable);
            const outputFilePath = path.join(__dirname, `${newCollectionName}.json`);

            fs.writeFileSync(outputFilePath, jsonData, "utf8");

            const environmentFilePath = path.join(__dirname, `${newCollectionName}-environment.json`);
            fs.writeFileSync(environmentFilePath, environmentData, "utf8");

            res.download(outputFilePath, `${newCollectionName}.json`, () => {
                fs.unlinkSync(filePath);
                fs.unlinkSync(outputFilePath);
                fs.unlinkSync(environmentFilePath);
            });
        } catch (error) {
            res.render("index4", { message: null, error: `Erreur : ${error.message}` });
        }
    });
});

app.listen(PORT, () => console.log(`✅ Serveur en ligne sur http://localhost:${PORT}`));
