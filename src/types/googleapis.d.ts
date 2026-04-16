declare module "googleapis" {
  export namespace sheets_v4 {
    interface Schema$Sheet {
      properties?: {
        sheetId?: number | null;
        title?: string | null;
      } | null;
    }

    interface Sheets {
      spreadsheets: {
        get(params: {
          spreadsheetId: string;
          fields?: string;
        }): Promise<{
          data: {
            sheets?: Schema$Sheet[] | null;
          };
        }>;
        values: {
          get(params: {
            spreadsheetId: string;
            range: string;
            valueRenderOption?: string;
            dateTimeRenderOption?: string;
          }): Promise<{
            data: {
              values?: unknown[][] | null;
            };
          }>;
        };
      };
    }
  }

  export const google: {
    auth: {
      GoogleAuth: new (options: {
        credentials: Record<string, unknown>;
        scopes: string[];
      }) => unknown;
    };
    sheets(options: {
      version: "v4";
      auth: unknown;
    }): sheets_v4.Sheets;
  };
}
