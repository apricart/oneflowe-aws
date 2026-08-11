import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getValueFontSize } from "@/components/dashboard/charts"

export function KpiCard({ title, value, hint, icon: Icon, colorClass = "text-blue-600" }: Readonly<{ title: string; value: string | number; hint?: string; icon?: any; colorClass?: string }>) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {Icon ? <Icon size={18} className="opacity-70" /> : null}
      </CardHeader>
      <CardContent>
        <div className={`${getValueFontSize(value)} font-bold ${colorClass} break-words leading-tight`}>{value}</div>
        {hint ? <div className="text-xs opacity-70 mt-1">{hint}</div> : null}
      </CardContent>
    </Card>
  )
}



