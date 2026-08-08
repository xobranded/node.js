'use strict';

const { skipIfSQLiteMissing } = require('../common');
skipIfSQLiteMissing();
const assert = require('node:assert');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');

for (const method of ['all', 'get', 'run', 'iterate']) {
  test(`database.close() from a UDF during statement.${method}()`, () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE data (value INTEGER);
      INSERT INTO data VALUES (1), (2), (3);
    `);

    db.function('close_db', (value) => {
      db.close();
      return value;
    });

    const statement = db.prepare('SELECT close_db(value) FROM data');
    assert.throws(() => {
      if (method === 'iterate') {
        for (const row of statement.iterate()) {
          assert.ok(row);
        }
      } else {
        statement[method]();
      }
    }, {
      code: 'ERR_INVALID_STATE',
      message: 'database cannot be closed while in a callback',
    });

    assert.strictEqual(db.isOpen, true);
    db.close();
  });

  // Finalizing the statement being stepped frees the virtual machine that
  // sqlite3_step() is still running, so this must throw rather than crash.
  test(`statement.close() from a UDF during statement.${method}()`, () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE data (value INTEGER);
      INSERT INTO data VALUES (1), (2), (3);
    `);

    let statement;
    db.function('close_stmt', (value) => {
      statement.close();
      return value;
    });

    statement = db.prepare('SELECT close_stmt(value) FROM data');
    assert.throws(() => {
      if (method === 'iterate') {
        for (const row of statement.iterate()) {
          assert.ok(row);
        }
      } else {
        statement[method]();
      }
    }, {
      code: 'ERR_INVALID_STATE',
      message: 'statement cannot be finalized while it is being executed',
    });

    db.close();
  });

  // A UDF may prepare and finalize its own helper statements. Only the
  // statement being stepped is off limits.
  test(`UDF finalizes its own statement during statement.${method}()`, () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE data (value INTEGER);
      INSERT INTO data VALUES (1), (2), (3);
      CREATE TABLE lookup (key INTEGER, label TEXT);
      INSERT INTO lookup VALUES (1, 'one'), (2, 'two'), (3, 'three');
    `);

    db.function('lookup_label', (value) => {
      const helper = db.prepare('SELECT label FROM lookup WHERE key = ?');
      const label = helper.get(value).label;
      helper.close();
      return label;
    });

    const statement = db.prepare('SELECT lookup_label(value) AS l FROM data');
    if (method === 'iterate') {
      const labels = [];
      for (const row of statement.iterate()) {
        labels.push(row.l);
      }
      assert.deepStrictEqual(labels, ['one', 'two', 'three']);
    } else if (method === 'all') {
      assert.deepStrictEqual(statement.all().map((r) => r.l),
                             ['one', 'two', 'three']);
    } else if (method === 'get') {
      assert.strictEqual(statement.get().l, 'one');
    } else {
      statement.run();
    }

    db.close();
  });
}
