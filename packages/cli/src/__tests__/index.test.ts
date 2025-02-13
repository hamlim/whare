import { describe, expect, test } from "bun:test";

// Import the core functions we want to test
import {
  Logger,
  createConflictMarkers,
  hasValueChanged,
  packageJsonHandler,
  transformToGitConflicts,
} from "../index";

describe("package.json diffing", () => {
  test("hasValueChanged detects value differences correctly", () => {
    // Same values
    expect(hasValueChanged("foo", "foo")).toBe(false);
    expect(hasValueChanged(123, 123)).toBe(false);
    expect(hasValueChanged({ a: 1 }, { a: 1 })).toBe(false);
    expect(hasValueChanged(["a", "b"], ["a", "b"])).toBe(false);

    // Different values
    expect(hasValueChanged("foo", "bar")).toBe(true);
    expect(hasValueChanged(123, 456)).toBe(true);
    expect(hasValueChanged({ a: 1 }, { a: 2 })).toBe(true);
    expect(hasValueChanged(["a", "b"], ["b", "a"])).toBe(true);

    // Different types
    expect(hasValueChanged("123", 123)).toBe(true);
    expect(hasValueChanged(null, undefined)).toBe(true);
    expect(hasValueChanged({}, [])).toBe(true);
  });

  test("createConflictMarkers generates correct markers", () => {
    const markers = createConflictMarkers(1, "test-key");

    expect(markers.start).toBe("conf-start::01");
    expect(markers.mid).toBe("conf-mid::01");
    expect(markers.end).toBe("conf-end::01");
    expect(markers.template).toBe("tmpl::test-key");
    expect(markers.current).toBe("curr::test-key");
  });

  test("transformToGitConflicts converts markers to git-style conflicts", () => {
    const input = JSON.stringify(
      {
        scripts: {
          "conf-start::00": "",
          "curr::dev": "do-something",
          "conf-mid::00": "",
          "tmpl::dev": "do-something-new",
          "conf-end::00": "",
          build: "same thing",
        },
      },
      null,
      2,
    );

    const expected = `{
  \"scripts\": {
<<<<<<< Local Package
    \"dev\": \"do-something\",
=======
    \"dev\": \"do-something-new\", // From template
>>>>>>> Template
    \"build\": \"same thing\"
  }
}`;

    const actual = transformToGitConflicts(input).trim();
    expect(actual).toBe(expected);
  });

  test("transformToGitConflicts handles multiple conflicts", () => {
    const input = JSON.stringify(
      {
        scripts: {
          "conf-start::00": "",
          "curr::dev": "do-something",
          "conf-mid::00": "",
          "tmpl::dev": "do-something-new",
          "conf-end::00": "",
          build: "same thing",
          "conf-start::01": "",
          "curr::test": "vitest",
          "conf-mid::01": "",
          "tmpl::test": "jest",
          "conf-end::01": "",
        },
      },
      null,
      2,
    );

    const expected = `{
  \"scripts\": {
<<<<<<< Local Package
    \"dev\": \"do-something\",
=======
    \"dev\": \"do-something-new\", // From template
>>>>>>> Template
    \"build\": \"same thing\",
<<<<<<< Local Package
    \"test\": \"vitest\"
=======
    \"test\": \"jest\" // From template
>>>>>>> Template
  }
}`;

    const actual = transformToGitConflicts(input).trim();
    expect(actual).toBe(expected);
  });
});

describe("package.json merge functionality", () => {
  const mockLogger = new Logger(false);

  test("merges package.json with conflicting script values", async () => {
    const current = JSON.stringify(
      {
        name: "my-package",
        version: "1.0.0",
        scripts: {
          build: "same thing",
          dev: "do-something",
        },
      },
      null,
      2,
    );

    const template = JSON.stringify(
      {
        name: "template-package",
        version: "2.0.0",
        scripts: {
          build: "same thing",
          dev: "do-something-new",
        },
      },
      null,
      2,
    );

    const expected = `{
  "name": "my-package",
  "version": "1.0.0",
  "scripts": {
    "build": "same thing",
<<<<<<< Local Package
    "dev": "do-something"
=======
    "dev": "do-something-new" // From template
>>>>>>> Template
  }
}`;

    const result = await packageJsonHandler.merge(
      current,
      template,
      mockLogger,
    );
    expect(result.trim()).toBe(expected);
  });

  test("merges package.json with multiple conflicts in dependencies", async () => {
    const current = JSON.stringify(
      {
        name: "my-package",
        dependencies: {
          react: "^17.0.0",
          typescript: "^4.0.0",
        },
      },
      null,
      2,
    );

    const template = JSON.stringify(
      {
        name: "template-package",
        dependencies: {
          react: "^18.0.0",
          typescript: "^5.0.0",
        },
      },
      null,
      2,
    );

    const expected = `{
  "name": "my-package",
  "dependencies": {
<<<<<<< Local Package
    "react": "^17.0.0",
=======
    "react": "^18.0.0", // From template
>>>>>>> Template
<<<<<<< Local Package
    "typescript": "^4.0.0"
=======
    "typescript": "^5.0.0" // From template
>>>>>>> Template
  }
}`;

    const result = await packageJsonHandler.merge(
      current,
      template,
      mockLogger,
    );
    expect(result.trim()).toBe(expected);
  });

  test("preserves protected fields and adds new fields from template", async () => {
    const current = JSON.stringify(
      {
        name: "my-package",
        version: "1.0.0",
        private: true,
      },
      null,
      2,
    );

    const template = JSON.stringify(
      {
        name: "template-package",
        version: "2.0.0",
        private: false,
        type: "module",
        engines: {
          node: ">=18",
        },
      },
      null,
      2,
    );

    const expected = `{
  "name": "my-package",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=18"
  }
}`;

    const result = await packageJsonHandler.merge(
      current,
      template,
      mockLogger,
    );
    expect(result.trim()).toBe(expected);
  });

  test("merges dependencies without conflicts for new entries", async () => {
    const current = JSON.stringify(
      {
        name: "my-package",
        dependencies: {
          react: "^17.0.0",
        },
      },
      null,
      2,
    );

    const template = JSON.stringify(
      {
        name: "template-package",
        dependencies: {
          react: "^17.0.0",
          "react-dom": "^17.0.0",
        },
      },
      null,
      2,
    );

    const expected = `{
  "name": "my-package",
  "dependencies": {
    "react": "^17.0.0",
    "react-dom": "^17.0.0"
  }
}`;

    const result = await packageJsonHandler.merge(
      current,
      template,
      mockLogger,
    );
    expect(result.trim()).toBe(expected);
  });

  test("handles empty merge fields in current package.json", async () => {
    const current = JSON.stringify(
      {
        name: "my-package",
      },
      null,
      2,
    );

    const template = JSON.stringify(
      {
        name: "template-package",
        dependencies: {
          react: "^17.0.0",
        },
        scripts: {
          dev: "next dev",
        },
      },
      null,
      2,
    );

    const expected = `{
  "name": "my-package",
  "dependencies": {
    "react": "^17.0.0"
  },
  "scripts": {
    "dev": "next dev"
  }
}`;

    const result = await packageJsonHandler.merge(
      current,
      template,
      mockLogger,
    );
    expect(result.trim()).toBe(expected);
  });
});
