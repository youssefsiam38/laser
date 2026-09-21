export interface TableProps {
  rows: string[];
  dense?: boolean;
}

export function Table({ rows, dense = false }: TableProps) {
  return (
    <table className="w-full" data-dense={dense}>
      <tbody>{rows.map((row) => <tr key={row}><td>{row}</td></tr>)}</tbody>
    </table>
  );
}
