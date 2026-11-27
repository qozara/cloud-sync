export class ConflictError extends Error {
  constructor(message = 'Data has been modified by another user.') {
    super(message);
    this.name = 'ConflictError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends Error {
  constructor(message = 'Resource not found.') {
    super(message);
    this.name = 'NotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SchemaCorruptedError extends Error {
  constructor(message = 'The underlying spreadsheet schema is missing required structure.') {
    super(message);
    this.name = 'SchemaCorruptedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SchemaUpgradeRequiredError extends Error {
  constructor(message = 'The underlying spreadsheet schema must be upgraded to continue.') {
    super(message);
    this.name = 'SchemaUpgradeRequiredError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SchemaIncompatibleError extends Error {
  constructor(
    message = 'The underlying spreadsheet schema was created or upgraded by a newer version of the application. Please update or reinstall the app.'
  ) {
    super(message);
    this.name = 'SchemaIncompatibleError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UnmanagedDocumentError extends Error {
  constructor(
    public readonly containerId?: string,
    message = 'This spreadsheet does not contain a valid application _meta manifest and cannot be modified.'
  ) {
    super(message);
    this.name = 'UnmanagedDocumentError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ForeignDocumentError extends Error {
  constructor(
    public readonly expectedAppId?: string,
    public readonly detectedAppId?: string,
    public readonly detectedDocType?: string,
    message?: string
  ) {
    super(
      message ||
        `This spreadsheet belongs to another application (${detectedAppId || 'unknown'}${detectedDocType ? `:${detectedDocType}` : ''}) and cannot be opened here.`
    );
    this.name = 'ForeignDocumentError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TableNotFoundError extends Error {
  constructor(
    public readonly tabName: string,
    message?: string
  ) {
    super(message || `Tabular sheet "${tabName}" not found in spreadsheet.`);
    this.name = 'TableNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class OfflineOperationError extends Error {
  public readonly action?: string;

  constructor(message = 'This operation requires an internet connection.', action?: string) {
    super(message);
    this.name = 'OfflineOperationError';
    this.action = action;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class GroupFileUnavailableError extends Error {
  constructor(
    public readonly groupId: string,
    public readonly groupName?: string,
    public readonly reason: 'trashed' | 'deleted' = 'deleted',
    message = 'The underlying spreadsheet file is no longer available in Google Drive.'
  ) {
    super(message);
    this.name = 'GroupFileUnavailableError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
