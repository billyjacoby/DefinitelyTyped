// @ts-check
import { flatMap, mapDefined } from "@definitelytyped/utils";
import { Octokit } from "@octokit/core";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * @typedef {{ githubUsername?: string }} Owner
 * @typedef {{ owners: Owner[]; raw: string; }} PackageInfo
 */
void 0;

/**
 * @param {string} packageJsonPath
 * @param {PackageInfo} info
 * @param {Set<string>} ghosts
 */
function bust(packageJsonPath, info, ghosts) {
    /** @param {Owner} c */
    const isGhost = c => c.githubUsername && ghosts.has(c.githubUsername.toLowerCase());
    if (info.owners.some(isGhost)) {
        console.log(`Found one or more deleted accounts in ${packageJsonPath}. Patching...`);
        const parsed = JSON.parse(info.raw);
        parsed.owners = info.owners.filter(c => !isGhost(c));
        const newContent = JSON.stringify(parsed, undefined, 4);
        writeFileSync(packageJsonPath, newContent + "\n", "utf-8");
    }
}

/**
 * @param {URL} dir
 * @param {(subpath: URL) => void} fn
 */
function recurse(dir, fn) {
    const entryPoints = readdirSync(dir, { withFileTypes: true });
    for (const subdir of entryPoints) {
        if (subdir.isDirectory() && subdir.name !== "node_modules") {
            const subpath = new URL(`${subdir.name}/`, dir);
            fn(subpath);
            recurse(subpath, fn);
        }
    }
}

function getAllPackageJsons() {
    /** @type {Record<string, PackageInfo>} */
    const headers = {};
    console.log("Reading headers...");
    recurse(new URL("../types/", import.meta.url), subpath => {
        const index = new URL("package.json", subpath);
        if (existsSync(index)) {
            const indexContent = readFileSync(index, "utf-8");
            let parsed;
            try {
                parsed = JSON.parse(indexContent);
            } catch (e) {}
            if (parsed && parsed.owners && Array.isArray(parsed.owners)) {
                headers[index.pathname] = { owners: parsed.owners, raw: indexContent };
            }
        }
    });
    return headers;
}

/**
 * @param {Set<string>} users
 */
async function fetchGhosts(users) {
    console.log("Checking for deleted accounts...");
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const maxPageSize = 2000;
    const pages = Math.ceil(users.size / maxPageSize);
    const userArray = Array.from(users);
    /** @type string[] */
    const ghosts = [];
    for (let page = 0; page < pages; page++) {
        const startIndex = page * maxPageSize;
        const endIndex = Math.min(startIndex + maxPageSize, userArray.length);
        const query = `query {
            ${userArray.slice(startIndex, endIndex).map((user, i) => `u${i}: user(login: "${user}") { id }`).join("\n")}
        }`;
        const result = await tryGQL(() => octokit.graphql(query));
        for (const k in result) {
            if (result[k] === null) {
                ghosts.push(userArray[startIndex + parseInt(k.substring(1), 10)]);
            }
        }
    }

    // Filter out organizations
    if (ghosts.length) {
        const query = `query {
            ${ghosts.map((user, i) => `o${i}: organization(login: "${user}") { id }`).join("\n")}
        }`;
        const result = await tryGQL(() => octokit.graphql(query));
        if (result) {
            return new Set(ghosts.filter(g => result[`o${ghosts.indexOf(g)}`] === null));
        }
    }

    return new Set(ghosts);
}

/**
 * @param {() => Promise<any>} fn
 */
async function tryGQL(fn) {
    try {
        const result = await fn();
        if (result.data) return result.data;
        return result;
        // @ts-expect-error
    } catch (/** @type {{}} */ resultWithErrors) {
        if (resultWithErrors.data) {
            return resultWithErrors.data;
        }
        throw resultWithErrors;
    }
}

process.on("unhandledRejection", err => {
    console.error(err);
    process.exit(1);
});

(async () => {
    if (!process.env.GITHUB_TOKEN) {
        throw new Error("GITHUB_TOKEN environment variable is not set");
    }

    const packageJsons = getAllPackageJsons();
    const users = new Set(
        flatMap(Object.values(packageJsons), h => mapDefined(h.owners, c => c.githubUsername?.toLowerCase())),
    );
    const ghosts = await fetchGhosts(users);
    if (!ghosts.size) {
        console.log("No ghosts found");
        return;
    }

    for (const indexPath in packageJsons) {
        bust(indexPath, packageJsons[indexPath], ghosts);
    }
})();
