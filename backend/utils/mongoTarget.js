/**
 * describeMongoTarget - "host/database" for a MongoDB URI, never any
 * credentials. A URI with no database name uses the driver default, "test",
 * so `implicitDatabase` is reported: a run against such a URI writes into
 * `test`, which is easy to overlook.
 */
export const describeMongoTarget = (uri) => {
  const match = String(uri || '').match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)\/?([^?]*)/);
  if (!match) return { host: null, database: null, label: '(unparseable)', implicitDatabase: false };
  const database = decodeURIComponent(match[2] || '') || 'test';
  return { host: match[1], database, label: `${match[1]}/${database}`, implicitDatabase: !match[2] };
};

/** Throws unless the URI resolves to exactly `expected` ("host/database"). No-op when `expected` is empty. */
export const assertMongoTarget = (uri, expected) => {
  const target = describeMongoTarget(uri);
  if (expected && expected !== target.label) {
    throw new Error(`Refusing to run: expected target ${expected} but MONGODB_URI resolves to ${target.label}`);
  }
  return target;
};

export default describeMongoTarget;
