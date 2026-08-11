"use client"

import * as React from "react"
import * as Select from "@radix-ui/react-select"
import * as Checkbox from "@radix-ui/react-checkbox"
import { ChevronDownIcon, CheckIcon } from "lucide-react"

const months = [
  { label: "January", value: "01" },
  { label: "February", value: "02" },
  { label: "March", value: "03" },
  { label: "April", value: "04" },
  { label: "May", value: "05" },
  { label: "June", value: "06" },
  { label: "July", value: "07" },
  { label: "August", value: "08" },
  { label: "September", value: "09" },
  { label: "October", value: "10" },
  { label: "November", value: "11" },
  { label: "December", value: "12" },
]

// Years will be generated dynamically inside the component


interface MonthYearPickerProps {
  selectedYear?: string
  selectedMonths?: string[]
  onYearChange?: (year: string) => void
  onMonthsChange?: (months: string[]) => void
}

export function MonthYearPicker({
  selectedYear: controlledYear,
  selectedMonths: controlledMonths,
  onYearChange,
  onMonthsChange,
}: Readonly<MonthYearPickerProps>) {
  const years = React.useMemo(() => {
    const currentYear = new Date().getFullYear()
    const startYear = 2022
    const endYear = currentYear + 1
    const yearsList = []
    for (let y = startYear; y <= endYear; y++) {
      yearsList.push(y.toString())
    }
    return yearsList.reverse()
  }, [])

  const [internalYear, setInternalYear] = React.useState(new Date().getFullYear().toString())
  const [internalMonths, setInternalMonths] = React.useState<string[]>([])

  // Use controlled values if provided, otherwise use internal state
  const year = controlledYear ?? internalYear
  const selectedMonths = controlledMonths ?? internalMonths

  const handleYearChange = (newYear: string) => {
    if (onYearChange) {
      onYearChange(newYear)
    } else {
      setInternalYear(newYear)
    }
  }

  const toggleMonth = (month: string) => {
    const newMonths = selectedMonths.includes(month)
      ? selectedMonths.filter((m) => m !== month)
      : [...selectedMonths, month]

    if (onMonthsChange) {
      onMonthsChange(newMonths)
    } else {
      setInternalMonths(newMonths)
    }
  }

  const selectAllMonths = () => {
    const allMonthValues = months.map(m => m.value)
    if (onMonthsChange) {
      onMonthsChange(allMonthValues)
    } else {
      setInternalMonths(allMonthValues)
    }
  }

  const clearAllMonths = () => {
    if (onMonthsChange) {
      onMonthsChange([])
    } else {
      setInternalMonths([])
    }
  }

  return (
    <div className="space-y-4 rounded-xl border-0 p-5 w-80 bg-white dark:bg-slate-800">
      {/* Year Select */}
      <div>
        <label htmlFor="month-year-picker-year" className="block mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">Year</label>

        <Select.Root value={year} onValueChange={handleYearChange}>
          <Select.Trigger id="month-year-picker-year" className="inline-flex w-full items-center justify-between rounded-lg border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2.5 text-sm font-medium hover:border-indigo-300 dark:hover:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400 focus:ring-offset-2 dark:focus:ring-offset-slate-800 transition-colors">
            <Select.Value className="text-slate-900 dark:text-slate-100" />
            <Select.Icon>
              <ChevronDownIcon className="h-4 w-4 text-slate-500 dark:text-slate-400" />
            </Select.Icon>
          </Select.Trigger>

          <Select.Portal>
            <Select.Content
              className="bg-white dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-lg shadow-xl dark:shadow-slate-900/50 z-[100] overflow-hidden"
              position="popper"
              sideOffset={4}
            >
              <Select.Viewport className="p-1">
                {years.map((y) => (
                  <Select.Item
                    key={y}
                    value={y}
                    className="relative flex items-center px-8 py-2.5 text-sm rounded-md cursor-pointer hover:bg-indigo-50 dark:hover:bg-indigo-900/30 focus:bg-indigo-50 dark:focus:bg-indigo-900/30 outline-none data-[highlighted]:bg-indigo-50 dark:data-[highlighted]:bg-indigo-900/30 transition-colors"
                  >
                    <Select.ItemIndicator className="absolute left-2 inline-flex items-center">
                      <CheckIcon className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                    </Select.ItemIndicator>
                    <Select.ItemText className="font-medium text-slate-900 dark:text-slate-100">{y}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
      </div>

      {/* Month Checkboxes */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="block text-sm font-semibold text-slate-700 dark:text-slate-300">
            Months
          </p>
          <div className="flex gap-2">
            <button type="button"
              onClick={selectAllMonths}
              className="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors"
            >
              Select All
            </button>
            <span className="text-slate-300 dark:text-slate-600">|</span>
            <button type="button"
              onClick={clearAllMonths}
              className="text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          {months.map((month) => (
            <label
              key={month.value}
              className="flex items-center gap-2.5 text-sm cursor-pointer group py-1.5 px-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
            >
              <Checkbox.Root
                checked={selectedMonths.includes(month.value)}
                onCheckedChange={() => toggleMonth(month.value)}
                className="h-5 w-5 rounded-md border-2 border-slate-300 dark:border-slate-600 flex items-center justify-center data-[state=checked]:bg-indigo-600 dark:data-[state=checked]:bg-indigo-500 data-[state=checked]:border-indigo-600 dark:data-[state=checked]:border-indigo-500 hover:border-indigo-400 dark:hover:border-indigo-500 transition-all focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:focus:ring-indigo-400 focus:ring-offset-2 dark:focus:ring-offset-slate-800"
              >
                <Checkbox.Indicator>
                  <CheckIcon className="h-3.5 w-3.5 text-white" />
                </Checkbox.Indicator>
              </Checkbox.Root>

              <span className="font-medium text-slate-700 dark:text-slate-300 group-hover:text-slate-900 dark:group-hover:text-slate-100 transition-colors">
                {month.label}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Summary */}
      <div className="text-xs bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-900/30 dark:to-purple-900/30 p-3 rounded-lg border border-indigo-100 dark:border-indigo-800">
        <div className="font-semibold text-indigo-900 dark:text-indigo-300 mb-1">Selection Summary</div>
        <div className="text-slate-600 dark:text-slate-400">
          <span className="font-medium">Year:</span> {year}
        </div>
        <div className="text-slate-600 dark:text-slate-400">
          <span className="font-medium">Months:</span> {selectedMonths.length > 0 ? `${selectedMonths.length} selected` : "None"}
        </div>
      </div>
    </div>
  )
}
